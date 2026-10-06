const fs = require('fs');
const path = require('path');
const config = require('../config');

// Using Node 22 built-in SQLite (DatabaseSync) with fallback to JSON store if ever needed
let db = null;
try {
  const { DatabaseSync } = require('node:sqlite');
  db = new DatabaseSync(config.DB_FILE);
  // Enable WAL mode for better concurrency
  db.exec('PRAGMA journal_mode = WAL;');
} catch (err) {
  console.warn('node:sqlite not available, falling back to JSON storage:', err.message);
}

// Fallback JSON DB if SQLite isn't available
const JSON_FILE = path.join(config.DATA_DIR, 'db_fallback.json');
let jsonStore = {
  db_configs: [],
  gdrive_configs: [],
  backup_history: [],
  restore_tests: [],
  settings: {
    cron_schedule: config.BACKUP_CRON,
    auto_verify_integrity: true,
    retention_days: 30
  }
};

function saveJsonStore() {
  fs.writeFileSync(JSON_FILE, JSON.stringify(jsonStore, null, 2), 'utf8');
}

function initStorage() {
  if (db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS db_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL, -- 'postgres' or 'mysql'
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        database_name TEXT NOT NULL,
        username TEXT NOT NULL,
        password TEXT,
        ssl INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        last_tested_at TEXT,
        test_status TEXT, -- 'SUCCESS' or 'FAILED'
        test_error TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS gdrive_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        auth_type TEXT NOT NULL, -- 'service_account' or 'oauth'
        service_account_json TEXT,
        client_id TEXT,
        client_secret TEXT,
        refresh_token TEXT,
        folder_id TEXT NOT NULL,
        folder_name TEXT,
        is_active INTEGER DEFAULT 1,
        last_tested_at TEXT,
        test_status TEXT,
        test_error TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS backup_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        db_config_id INTEGER,
        database_name TEXT NOT NULL,
        db_type TEXT NOT NULL,
        filename TEXT NOT NULL,
        gdrive_file_id TEXT,
        gdrive_url TEXT,
        size_bytes INTEGER DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        status TEXT NOT NULL, -- 'STREAMING', 'SUCCESS', 'FAILED'
        error_message TEXT,
        checksum_sha256 TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS restore_tests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        backup_history_id INTEGER,
        test_type TEXT NOT NULL, -- 'GZIP_STREAM_CHECK', 'ARCHIVE_CATALOG', 'SANDBOX_RESTORE'
        status TEXT NOT NULL, -- 'PASSED', 'FAILED', 'RUNNING'
        tables_verified INTEGER DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        logs TEXT,
        error_message TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);

    // Seed default settings if empty
    const stmt = db.prepare("SELECT value FROM settings WHERE key = 'cron_schedule'");
    const row = stmt.get();
    if (!row) {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run('cron_schedule', config.BACKUP_CRON);
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run('auto_verify_integrity', 'true');
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run('retention_days', '30');
    }

    // Seed default DB config from .env if table is empty and env has values
    const countDb = db.prepare("SELECT count(*) as count FROM db_configs").get();
    if (countDb.count === 0 && config.DEFAULT_DB.name) {
      db.prepare(`
        INSERT INTO db_configs (name, type, host, port, database_name, username, password, ssl, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        'Primary DB (' + config.DEFAULT_DB.type + ')',
        config.DEFAULT_DB.type,
        config.DEFAULT_DB.host,
        config.DEFAULT_DB.port,
        config.DEFAULT_DB.name,
        config.DEFAULT_DB.user,
        config.DEFAULT_DB.password,
        config.DEFAULT_DB.ssl ? 1 : 0
      );
    }

    // Seed Google Drive config from .env if empty and env has values
    const countDrive = db.prepare("SELECT count(*) as count FROM gdrive_configs").get();
    if (countDrive.count === 0 && (config.GDRIVE.folderId || config.GDRIVE.serviceAccountKey || config.GDRIVE.serviceAccountFile)) {
      let saJson = config.GDRIVE.serviceAccountKey;
      if (!saJson && config.GDRIVE.serviceAccountFile && fs.existsSync(config.GDRIVE.serviceAccountFile)) {
        try { saJson = fs.readFileSync(config.GDRIVE.serviceAccountFile, 'utf8'); } catch (e) {}
      }

      const authType = saJson ? 'service_account' : 'oauth';
      db.prepare(`
        INSERT INTO gdrive_configs (auth_type, service_account_json, client_id, client_secret, refresh_token, folder_id, is_active)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `).run(
        authType,
        saJson || '',
        config.GDRIVE.clientId || '',
        config.GDRIVE.clientSecret || '',
        config.GDRIVE.refreshToken || '',
        config.GDRIVE.folderId || ''
      );
    }
  } else {
    // JSON fallback initialization
    if (fs.existsSync(JSON_FILE)) {
      try {
        jsonStore = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));
      } catch (e) {}
    } else {
      saveJsonStore();
    }
  }
}

// Storage Operations
const storage = {
  init: initStorage,

  // Database Configurations
  getDbConfigs: () => {
    if (db) {
      return db.prepare("SELECT * FROM db_configs ORDER BY id DESC").all();
    }
    return jsonStore.db_configs;
  },

  getDbConfigById: (id) => {
    if (db) {
      return db.prepare("SELECT * FROM db_configs WHERE id = ?").get(id);
    }
    return jsonStore.db_configs.find(d => d.id === Number(id));
  },

  saveDbConfig: (item) => {
    if (db) {
      if (item.id) {
        db.prepare(`
          UPDATE db_configs SET
            name = ?, type = ?, host = ?, port = ?, database_name = ?,
            username = ?, password = COALESCE(NULLIF(?, ''), password), ssl = ?, is_active = ?
          WHERE id = ?
        `).run(
          item.name, item.type, item.host, item.port, item.database_name,
          item.username, item.password || '', item.ssl ? 1 : 0, item.is_active ? 1 : 0, item.id
        );
        return item.id;
      } else {
        const result = db.prepare(`
          INSERT INTO db_configs (name, type, host, port, database_name, username, password, ssl, is_active)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          item.name, item.type, item.host, item.port, item.database_name,
          item.username, item.password || '', item.ssl ? 1 : 0, item.is_active !== undefined ? (item.is_active ? 1 : 0) : 1
        );
        return result.lastInsertRowid;
      }
    }
    // Fallback JSON
    if (item.id) {
      const idx = jsonStore.db_configs.findIndex(d => d.id === Number(item.id));
      if (idx !== -1) {
        jsonStore.db_configs[idx] = { ...jsonStore.db_configs[idx], ...item };
        saveJsonStore();
        return item.id;
      }
    }
    const newId = jsonStore.db_configs.length + 1;
    jsonStore.db_configs.push({ ...item, id: newId, created_at: new Date().toISOString() });
    saveJsonStore();
    return newId;
  },

  deleteDbConfig: (id) => {
    if (db) {
      db.prepare("DELETE FROM db_configs WHERE id = ?").run(id);
      return true;
    }
    jsonStore.db_configs = jsonStore.db_configs.filter(d => d.id !== Number(id));
    saveJsonStore();
    return true;
  },

  updateDbTestStatus: (id, status, error = null) => {
    const now = new Date().toISOString();
    if (db) {
      db.prepare("UPDATE db_configs SET test_status = ?, test_error = ?, last_tested_at = ? WHERE id = ?")
        .run(status, error, now, id);
    } else {
      const c = jsonStore.db_configs.find(d => d.id === Number(id));
      if (c) { c.test_status = status; c.test_error = error; c.last_tested_at = now; saveJsonStore(); }
    }
  },

  // Google Drive Configurations
  getGDriveConfig: () => {
    if (db) {
      return db.prepare("SELECT * FROM gdrive_configs WHERE is_active = 1 ORDER BY id DESC LIMIT 1").get();
    }
    return jsonStore.gdrive_configs.find(g => g.is_active) || jsonStore.gdrive_configs[0];
  },

  saveGDriveConfig: (item) => {
    const current = (db
      ? db.prepare("SELECT * FROM gdrive_configs WHERE is_active = 1 ORDER BY id DESC LIMIT 1").get()
      : (jsonStore.gdrive_configs.find(g => g.is_active) || jsonStore.gdrive_configs[0])) || {};

    const auth_type = item.auth_type || current.auth_type || 'service_account';
    const service_account_json = item.service_account_json !== undefined ? item.service_account_json : (current.service_account_json || '');
    const client_id = item.client_id !== undefined ? item.client_id : (current.client_id || '');
    const client_secret = (item.client_secret && item.client_secret !== '********') ? item.client_secret : (current.client_secret || '');
    const refresh_token = (item.refresh_token && item.refresh_token !== '********') ? item.refresh_token : (current.refresh_token || '');
    const folder_id = item.folder_id !== undefined ? item.folder_id : (current.folder_id || '');
    const folder_name = item.folder_name !== undefined ? item.folder_name : (current.folder_name || '');

    if (db) {
      // Deactivate older active configs
      db.prepare("UPDATE gdrive_configs SET is_active = 0").run();
      const result = db.prepare(`
        INSERT INTO gdrive_configs (auth_type, service_account_json, client_id, client_secret, refresh_token, folder_id, folder_name, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        auth_type,
        service_account_json,
        client_id,
        client_secret,
        refresh_token,
        folder_id,
        folder_name
      );
      return result.lastInsertRowid;
    }
    jsonStore.gdrive_configs.forEach(g => g.is_active = 0);
    const newId = jsonStore.gdrive_configs.length + 1;
    const rec = {
      auth_type,
      service_account_json,
      client_id,
      client_secret,
      refresh_token,
      folder_id,
      folder_name,
      id: newId,
      is_active: 1,
      created_at: new Date().toISOString()
    };
    jsonStore.gdrive_configs.push(rec);
    saveJsonStore();
    return newId;
  },

  updateGDriveTestStatus: (id, status, folderName = '', error = null) => {
    const now = new Date().toISOString();
    if (db) {
      db.prepare("UPDATE gdrive_configs SET test_status = ?, folder_name = ?, test_error = ?, last_tested_at = ? WHERE id = ?")
        .run(status, folderName, error, now, id);
    }
  },

  // Backup History
  createBackupHistory: (record) => {
    if (db) {
      const res = db.prepare(`
        INSERT INTO backup_history (db_config_id, database_name, db_type, filename, status, created_at)
        VALUES (?, ?, ?, ?, 'STREAMING', datetime('now'))
      `).run(record.db_config_id, record.database_name, record.db_type, record.filename);
      return Number(res.lastInsertRowid);
    }
    const newId = jsonStore.backup_history.length + 1;
    const rec = { ...record, id: newId, status: 'STREAMING', created_at: new Date().toISOString() };
    jsonStore.backup_history.unshift(rec);
    saveJsonStore();
    return newId;
  },

  updateBackupHistory: (id, update) => {
    if (db) {
      const fields = [];
      const values = [];
      for (const [key, val] of Object.entries(update)) {
        fields.push(`${key} = ?`);
        values.push(val);
      }
      values.push(id);
      db.prepare(`UPDATE backup_history SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    } else {
      const idx = jsonStore.backup_history.findIndex(h => h.id === Number(id));
      if (idx !== -1) {
        jsonStore.backup_history[idx] = { ...jsonStore.backup_history[idx], ...update };
        saveJsonStore();
      }
    }
  },

  getBackupHistory: (limit = 50) => {
    if (db) {
      return db.prepare("SELECT * FROM backup_history ORDER BY id DESC LIMIT ?").all(limit);
    }
    return jsonStore.backup_history.slice(0, limit);
  },

  getBackupById: (id) => {
    if (db) {
      return db.prepare("SELECT * FROM backup_history WHERE id = ?").get(id);
    }
    return jsonStore.backup_history.find(h => h.id === Number(id));
  },

  // Restore Tests
  createRestoreTest: (record) => {
    if (db) {
      const res = db.prepare(`
        INSERT INTO restore_tests (backup_history_id, test_type, status, created_at)
        VALUES (?, ?, 'RUNNING', datetime('now'))
      `).run(record.backup_history_id, record.test_type);
      return Number(res.lastInsertRowid);
    }
    const newId = jsonStore.restore_tests.length + 1;
    const rec = { ...record, id: newId, status: 'RUNNING', created_at: new Date().toISOString() };
    jsonStore.restore_tests.unshift(rec);
    saveJsonStore();
    return newId;
  },

  updateRestoreTest: (id, update) => {
    if (db) {
      const fields = [];
      const values = [];
      for (const [key, val] of Object.entries(update)) {
        fields.push(`${key} = ?`);
        values.push(val);
      }
      values.push(id);
      db.prepare(`UPDATE restore_tests SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    } else {
      const idx = jsonStore.restore_tests.findIndex(r => r.id === Number(id));
      if (idx !== -1) {
        jsonStore.restore_tests[idx] = { ...jsonStore.restore_tests[idx], ...update };
        saveJsonStore();
      }
    }
  },

  getRestoreTests: (limit = 50) => {
    if (db) {
      return db.prepare(`
        SELECT rt.*, bh.database_name, bh.filename, bh.gdrive_file_id
        FROM restore_tests rt
        LEFT JOIN backup_history bh ON rt.backup_history_id = bh.id
        ORDER BY rt.id DESC LIMIT ?
      `).all(limit);
    }
    return jsonStore.restore_tests.slice(0, limit);
  },

  // System Settings
  getSetting: (key, defaultValue = null) => {
    if (db) {
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
      return row ? row.value : defaultValue;
    }
    return jsonStore.settings[key] !== undefined ? jsonStore.settings[key] : defaultValue;
  },

  setSetting: (key, value) => {
    if (db) {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?")
        .run(key, String(value), String(value));
    } else {
      jsonStore.settings[key] = value;
      saveJsonStore();
    }
  },

  getAllSettings: () => {
    if (db) {
      const rows = db.prepare("SELECT key, value FROM settings").all();
      const obj = {};
      rows.forEach(r => obj[r.key] = r.value);
      return obj;
    }
    return jsonStore.settings;
  },

  // Aggregated Stats
  getStats: () => {
    if (db) {
      const total = db.prepare("SELECT count(*) as count FROM backup_history").get().count;
      const success = db.prepare("SELECT count(*) as count FROM backup_history WHERE status = 'SUCCESS'").get().count;
      const totalBytes = db.prepare("SELECT COALESCE(sum(size_bytes), 0) as total FROM backup_history WHERE status = 'SUCCESS'").get().total;
      const totalTests = db.prepare("SELECT count(*) as count FROM restore_tests").get().count;
      const passedTests = db.prepare("SELECT count(*) as count FROM restore_tests WHERE status = 'PASSED'").get().count;

      return {
        totalBackups: total,
        successfulBackups: success,
        totalBytesUploaded: totalBytes,
        totalRestoreTests: totalTests,
        passedRestoreTests: passedTests,
        successRate: total > 0 ? Math.round((success / total) * 100) : 100,
        testPassRate: totalTests > 0 ? Math.round((passedTests / totalTests) * 100) : 100
      };
    }
    const total = jsonStore.backup_history.length;
    const success = jsonStore.backup_history.filter(b => b.status === 'SUCCESS').length;
    const totalBytes = jsonStore.backup_history.filter(b => b.status === 'SUCCESS').reduce((acc, b) => acc + (b.size_bytes || 0), 0);
    const totalTests = jsonStore.restore_tests.length;
    const passedTests = jsonStore.restore_tests.filter(t => t.status === 'PASSED').length;
    return {
      totalBackups: total,
      successfulBackups: success,
      totalBytesUploaded: totalBytes,
      totalRestoreTests: totalTests,
      passedRestoreTests: passedTests,
      successRate: total > 0 ? Math.round((success / total) * 100) : 100,
      testPassRate: totalTests > 0 ? Math.round((passedTests / totalTests) * 100) : 100
    };
  }
};

module.exports = storage;
