const { spawn } = require('child_process');
const zlib = require('zlib');
const crypto = require('crypto');
const { Transform, PassThrough } = require('stream');
const { Client: PgClient } = require('pg');
const mysql = require('mysql2/promise');
const storage = require('../db/storage');
const GoogleDriveService = require('./gdrive');

class DatabaseStreamer {
  /**
   * Tests connection to a database configuration
   */
  static async testConnection(dbConfig) {
    const startTime = Date.now();
    const type = (dbConfig.type || 'postgres').toLowerCase();

    if (type === 'postgres' || type === 'postgresql') {
      const client = new PgClient({
        host: dbConfig.host,
        port: parseInt(dbConfig.port, 10) || 5432,
        database: dbConfig.database_name,
        user: dbConfig.username,
        password: dbConfig.password,
        ssl: dbConfig.ssl ? { rejectUnauthorized: false } : false,
        connectionTimeoutMillis: 7000,
      });

      try {
        await client.connect();
        const res = await client.query('SELECT version();');
        await client.end();
        const latencyMs = Date.now() - startTime;
        return {
          ok: true,
          version: res.rows[0].version,
          latencyMs,
          message: `Connected to PostgreSQL in ${latencyMs}ms.`,
        };
      } catch (err) {
        try { await client.end(); } catch (e) {}
        throw new Error(`PostgreSQL Connection Failed: ${err.message}`);
      }
    } else if (type === 'mysql' || type === 'mariadb') {
      try {
        const connection = await mysql.createConnection({
          host: dbConfig.host,
          port: parseInt(dbConfig.port, 10) || 3306,
          database: dbConfig.database_name,
          user: dbConfig.username,
          password: dbConfig.password,
          ssl: dbConfig.ssl ? { rejectUnauthorized: false } : undefined,
          connectTimeout: 7000,
        });

        const [rows] = await connection.execute('SELECT VERSION() as version');
        await connection.end();
        const latencyMs = Date.now() - startTime;
        return {
          ok: true,
          version: rows[0].version,
          latencyMs,
          message: `Connected to MySQL in ${latencyMs}ms.`,
        };
      } catch (err) {
        throw new Error(`MySQL Connection Failed: ${err.message}`);
      }
    } else {
      throw new Error(`Unsupported database type: ${type}`);
    }
  }

  /**
   * Executes a database backup streamed directly to Google Drive
   * (Zero temporary files created on disk)
   */
  static async streamBackup(dbConfigId, options = {}) {
    const dbConfig = storage.getDbConfigById(dbConfigId);
    if (!dbConfig) {
      throw new Error(`Database configuration ID ${dbConfigId} not found.`);
    }

    const type = (dbConfig.type || 'postgres').toLowerCase();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `backup_${dbConfig.database_name}_${timestamp}.sql.gz`;

    // 1. Create history record in STREAMING status
    const historyId = storage.createBackupHistory({
      db_config_id: dbConfig.id,
      database_name: dbConfig.database_name,
      db_type: type,
      filename,
    });

    const startTime = Date.now();
    console.log(`[Streamer] Initiating zero-disk backup stream for ${dbConfig.database_name} (${type})...`);

    try {
      // 2. Setup Dump child process
      let dumpProcess;
      let stderrOutput = '';

      if (type === 'postgres' || type === 'postgresql') {
        const args = [
          '-h', dbConfig.host,
          '-p', String(dbConfig.port || 5432),
          '-U', dbConfig.username,
          '-d', dbConfig.database_name,
          '--clean',
          '--if-exists',
          '--no-owner',
          '--no-privileges',
        ];

        const env = {
          ...process.env,
          PGPASSWORD: dbConfig.password || '',
        };

        if (dbConfig.ssl) {
          env.PGSSLMODE = 'require';
        }

        dumpProcess = spawn('pg_dump', args, { env });
      } else if (type === 'mysql' || type === 'mariadb') {
        const args = [
          '-h', dbConfig.host,
          '-P', String(dbConfig.port || 3306),
          '-u', dbConfig.username,
          `--password=${dbConfig.password || ''}`,
          '--single-transaction',
          '--quick',
          '--routines',
          '--triggers',
          dbConfig.database_name,
        ];

        dumpProcess = spawn('mysqldump', args);
      } else {
        throw new Error(`Unsupported database type for streaming dump: ${type}`);
      }

      dumpProcess.stderr.on('data', (chunk) => {
        stderrOutput += chunk.toString();
      });

      // 3. Setup on-the-fly Streaming Pipeline:
      // dumpProcess.stdout -> gzip -> hash & byte counter transform -> Google Drive upload
      const gzipStream = zlib.createGzip({ level: 6 });
      const hash = crypto.createHash('sha256');
      let totalBytesCompressed = 0;

      const monitorStream = new Transform({
        transform(chunk, encoding, callback) {
          totalBytesCompressed += chunk.length;
          hash.update(chunk);
          callback(null, chunk);
        },
      });

      // Pipe dump output through gzip and monitor
      dumpProcess.stdout.pipe(gzipStream).pipe(monitorStream);

      // Handle process errors
      let processFailed = false;
      let processErrorMessage = '';

      dumpProcess.on('error', (err) => {
        processFailed = true;
        processErrorMessage = `Failed to spawn dump utility (${type === 'mysql' ? 'mysqldump' : 'pg_dump'}): ${err.message}. Make sure database client utilities are installed.`;
        gzipStream.destroy(new Error(processErrorMessage));
      });

      // 4. Stream directly to Google Drive upload API
      const uploadPromise = GoogleDriveService.uploadStream({
        name: filename,
        stream: monitorStream,
        mimeType: 'application/gzip',
        folderId: options.folderId || null,
      });

      // Wait for process exit and upload completion concurrently
      const exitPromise = new Promise((resolve, reject) => {
        dumpProcess.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(`Dump utility exited with code ${code}. Error: ${stderrOutput.trim() || 'Unknown dump error'}`));
          } else {
            resolve();
          }
        });
      });

      const [uploadedFile] = await Promise.all([uploadPromise, exitPromise]);
      const durationMs = Date.now() - startTime;
      const finalHash = hash.digest('hex');

      console.log(`[Streamer] Stream complete! Uploaded ${filename} (${totalBytesCompressed} bytes, ${durationMs}ms, SHA256: ${finalHash.substring(0, 12)}...)`);

      // 5. Update history status to SUCCESS
      storage.updateBackupHistory(historyId, {
        status: 'SUCCESS',
        gdrive_file_id: uploadedFile.id,
        gdrive_url: uploadedFile.webViewLink,
        size_bytes: totalBytesCompressed,
        duration_ms: durationMs,
        checksum_sha256: finalHash,
        error_message: null,
      });

      return {
        id: historyId,
        filename,
        fileId: uploadedFile.id,
        webViewLink: uploadedFile.webViewLink,
        sizeBytes: totalBytesCompressed,
        durationMs,
        checksum: finalHash,
      };
    } catch (err) {
      console.error(`[Streamer] Backup streaming failed for ${dbConfig.database_name}:`, err.message);
      storage.updateBackupHistory(historyId, {
        status: 'FAILED',
        error_message: err.message,
        duration_ms: Date.now() - startTime,
      });
      throw err;
    }
  }
}

module.exports = DatabaseStreamer;
