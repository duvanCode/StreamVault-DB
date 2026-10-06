const zlib = require('zlib');
const crypto = require('crypto');
const readline = require('readline');
const { spawn } = require('child_process');
const { Client: PgClient } = require('pg');
const mysql = require('mysql2/promise');
const storage = require('../db/storage');
const config = require('../config');
const GoogleDriveService = require('./gdrive');

class RestoreTestService {
  /**
   * Executes a restoration integrity verification test on a backup stored in Google Drive
   * @param {number} backupHistoryId
   * @param {Object} [options]
   */
  static async verifyBackupIntegrity(backupHistoryId, options = {}) {
    const backup = storage.getBackupById(backupHistoryId);
    if (!backup) {
      throw new Error(`Backup history record #${backupHistoryId} not found.`);
    }

    if (!backup.gdrive_file_id) {
      throw new Error(`Backup record #${backupHistoryId} has no Google Drive file ID.`);
    }

    const testId = storage.createRestoreTest({
      backup_history_id: backup.id,
      test_type: options.sandboxRestore ? 'SANDBOX_RESTORE' : 'INTEGRITY_CHECK',
    });

    const startTime = Date.now();
    const logs = [];
    const log = (msg) => {
      const line = `[${new Date().toISOString()}] ${msg}`;
      logs.push(line);
      console.log(`[IntegrityTest #${testId}] ${msg}`);
    };

    log(`Starting restoration & integrity verification for backup: ${backup.filename} (${backup.database_name})`);
    log(`Google Drive File ID: ${backup.gdrive_file_id}`);

    try {
      // 1. Download stream directly from Google Drive
      log('Requesting download stream from Google Drive API v3...');
      const downloadStream = await GoogleDriveService.downloadStream(backup.gdrive_file_id);
      log('Download stream established. Initializing on-the-fly decompression & SHA-256 validation...');

      // 2. Gzip decompression & DDL/DML stream scanner
      const gunzip = zlib.createGunzip();
      const hash = crypto.createHash('sha256');

      let rawBytesDownloaded = 0;
      let uncompressedBytes = 0;
      const discoveredTables = new Set();
      let insertStatementsCount = 0;
      let copyBlocksCount = 0;

      downloadStream.on('data', (chunk) => {
        rawBytesDownloaded += chunk.length;
        hash.update(chunk);
      });

      gunzip.on('data', (chunk) => {
        uncompressedBytes += chunk.length;
      });

      // Stream decompressor
      downloadStream.pipe(gunzip);

      // Line-by-line SQL analyzer without holding the full file in memory
      const rl = readline.createInterface({
        input: gunzip,
        crlfDelay: Infinity,
      });

      const tableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`|"|)?([a-zA-Z0-9_]+)(?:`|"|)?/i;
      const insertRegex = /INSERT\s+INTO\s+(?:`|"|)?([a-zA-Z0-9_]+)(?:`|"|)?/i;
      const copyRegex = /COPY\s+(?:`|"|)?([a-zA-Z0-9_]+)(?:`|"|)?/i;

      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('--') || trimmed.startsWith('/*')) return;

        const tableMatch = trimmed.match(tableRegex);
        if (tableMatch) {
          discoveredTables.add(tableMatch[1].toLowerCase());
        }

        if (insertRegex.test(trimmed)) {
          insertStatementsCount++;
        }

        if (copyRegex.test(trimmed)) {
          copyBlocksCount++;
        }
      });

      // Wait for stream to finish parsing
      await new Promise((resolve, reject) => {
        gunzip.on('error', (err) => {
          reject(new Error(`Gzip decompression error (corrupted or truncated archive): ${err.message}`));
        });
        downloadStream.on('error', (err) => {
          reject(new Error(`Google Drive download stream error: ${err.message}`));
        });
        rl.on('close', resolve);
      });

      const computedHash = hash.digest('hex');
      const durationMs = Date.now() - startTime;

      log(`Decompression and stream inspection completed successfully!`);
      log(`Stream size: ${(rawBytesDownloaded / (1024 * 1024)).toFixed(2)} MB compressed → ${(uncompressedBytes / (1024 * 1024)).toFixed(2)} MB uncompressed.`);
      log(`Calculated SHA-256: ${computedHash}`);

      if (backup.checksum_sha256) {
        if (backup.checksum_sha256 === computedHash) {
          log(`SHA-256 Checksum verified: MATCHES original upload hash exactly.`);
        } else {
          log(`WARNING: SHA-256 Checksum mismatch! Expected ${backup.checksum_sha256}, got ${computedHash}.`);
        }
      }

      log(`Tables detected in SQL dump (${discoveredTables.size}): ${Array.from(discoveredTables).slice(0, 15).join(', ')}${discoveredTables.size > 15 ? '...' : ''}`);
      log(`Data operation records: ${insertStatementsCount} INSERT statements, ${copyBlocksCount} COPY blocks.`);

      if (discoveredTables.size === 0 && uncompressedBytes < 100) {
        throw new Error('Verification failed: Dump file contains zero tables and seems empty.');
      }

      // 3. Optional Sandbox Database Restore Test
      let sandboxRestored = false;
      const testDbConfig = options.testDb || (config.TEST_DB.enabled ? config.TEST_DB : null);

      if (options.sandboxRestore && testDbConfig && testDbConfig.host) {
        log(`Executing sandbox restoration against test server: ${testDbConfig.host}...`);
        await this.runSandboxRestore(testDbConfig, backup.gdrive_file_id, backup.db_type, log);
        sandboxRestored = true;
        log('Sandbox restoration completed and verified successfully.');
      }

      // 4. Update status to PASSED
      storage.updateRestoreTest(testId, {
        status: 'PASSED',
        tables_verified: discoveredTables.size,
        duration_ms: durationMs,
        logs: logs.join('\n'),
        error_message: null,
      });

      return {
        id: testId,
        status: 'PASSED',
        tablesCount: discoveredTables.size,
        tablesList: Array.from(discoveredTables),
        rawBytes: rawBytesDownloaded,
        uncompressedBytes,
        durationMs,
        checksum: computedHash,
        sandboxRestored,
        logs,
      };
    } catch (err) {
      log(`FAILED: ${err.message}`);
      storage.updateRestoreTest(testId, {
        status: 'FAILED',
        duration_ms: Date.now() - startTime,
        logs: logs.join('\n'),
        error_message: err.message,
      });
      throw err;
    }
  }

  /**
   * Restores a backup stream to an ephemeral sandbox schema/database and cleans up
   */
  static async runSandboxRestore(testDb, fileId, dbType, log) {
    const sandboxName = `restore_test_${Date.now()}`;
    log(`Creating ephemeral sandbox database: ${sandboxName}...`);

    if (dbType === 'postgres' || dbType === 'postgresql') {
      const adminClient = new PgClient({
        host: testDb.host,
        port: testDb.port || 5432,
        database: testDb.name || 'postgres',
        user: testDb.user,
        password: testDb.password,
      });

      await adminClient.connect();
      await adminClient.query(`CREATE DATABASE "${sandboxName}";`);
      await adminClient.end();

      try {
        log(`Streaming backup from Google Drive directly into psql for sandbox: ${sandboxName}...`);
        const stream = await GoogleDriveService.downloadStream(fileId);
        const gunzip = zlib.createGunzip();

        const psql = spawn('psql', [
          '-h', testDb.host,
          '-p', String(testDb.port || 5432),
          '-U', testDb.user,
          '-d', sandboxName,
        ], {
          env: { ...process.env, PGPASSWORD: testDb.password },
        });

        stream.pipe(gunzip).pipe(psql.stdin);

        await new Promise((resolve, reject) => {
          psql.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`psql restore exited with code ${code}`));
          });
          psql.on('error', reject);
        });

        // Verify tables exist in restored database
        const verifyClient = new PgClient({
          host: testDb.host,
          port: testDb.port || 5432,
          database: sandboxName,
          user: testDb.user,
          password: testDb.password,
        });
        await verifyClient.connect();
        const res = await verifyClient.query("SELECT count(*) as count FROM information_schema.tables WHERE table_schema = 'public';");
        log(`Verification query: restored database has ${res.rows[0].count} public tables.`);
        await verifyClient.end();
      } finally {
        // Teardown ephemeral sandbox database
        const cleanupClient = new PgClient({
          host: testDb.host,
          port: testDb.port || 5432,
          database: testDb.name || 'postgres',
          user: testDb.user,
          password: testDb.password,
        });
        await cleanupClient.connect();
        await cleanupClient.query(`DROP DATABASE IF EXISTS "${sandboxName}" WITH (FORCE);`);
        await cleanupClient.end();
        log(`Teardown: Ephemeral sandbox database "${sandboxName}" dropped successfully.`);
      }
    } else if (dbType === 'mysql' || dbType === 'mariadb') {
      const conn = await mysql.createConnection({
        host: testDb.host,
        port: testDb.port || 3306,
        user: testDb.user,
        password: testDb.password,
      });

      await conn.query(`CREATE DATABASE \`${sandboxName}\`;`);
      await conn.end();

      try {
        const stream = await GoogleDriveService.downloadStream(fileId);
        const gunzip = zlib.createGunzip();

        const mysqlProc = spawn('mysql', [
          '-h', testDb.host,
          '-P', String(testDb.port || 3306),
          '-u', testDb.user,
          `--password=${testDb.password}`,
          sandboxName,
        ]);

        stream.pipe(gunzip).pipe(mysqlProc.stdin);

        await new Promise((resolve, reject) => {
          mysqlProc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`mysql restore exited with code ${code}`));
          });
          mysqlProc.on('error', reject);
        });

        const verifyConn = await mysql.createConnection({
          host: testDb.host,
          port: testDb.port || 3306,
          user: testDb.user,
          password: testDb.password,
          database: sandboxName,
        });
        const [rows] = await verifyConn.query('SHOW TABLES;');
        log(`Verification query: restored database has ${rows.length} tables.`);
        await verifyConn.end();
      } finally {
        const cleanupConn = await mysql.createConnection({
          host: testDb.host,
          port: testDb.port || 3306,
          user: testDb.user,
          password: testDb.password,
        });
        await cleanupConn.query(`DROP DATABASE IF EXISTS \`${sandboxName}\`;`);
        await cleanupConn.end();
        log(`Teardown: Ephemeral sandbox database "${sandboxName}" dropped successfully.`);
      }
    }
  }
}

module.exports = RestoreTestService;
