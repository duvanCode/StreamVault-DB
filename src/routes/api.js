const express = require('express');
const router = express.Router();
const storage = require('../db/storage');
const DatabaseStreamer = require('../services/streamer');
const GoogleDriveService = require('../services/gdrive');
const RestoreTestService = require('../services/restoreTest');
const scheduler = require('../services/scheduler');
const config = require('../config');

// Health check endpoint for Dokploy / Docker container monitoring
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Overall Dashboard Summary & Statistics
router.get('/status', (req, res) => {
  try {
    const stats = storage.getStats();
    const gdriveConfig = storage.getGDriveConfig();
    const dbConfigs = storage.getDbConfigs();
    const settings = storage.getAllSettings();

    res.json({
      success: true,
      stats,
      scheduler: {
        activeSchedule: scheduler.currentSchedule,
        isExecuting: scheduler.isExecuting,
        timezone: config.TIMEZONE,
      },
      hasDriveConfig: Boolean(gdriveConfig && gdriveConfig.is_active),
      activeDbCount: dbConfigs.filter(d => d.is_active).length,
      settings,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Database Configurations Endpoints
router.get('/db-configs', (req, res) => {
  try {
    const configs = storage.getDbConfigs().map(d => ({
      ...d,
      password: d.password ? '********' : '', // Mask password
    }));
    res.json({ success: true, data: configs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/db-configs', async (req, res) => {
  try {
    const { name, type, host, port, database_name, username, password, ssl, is_active } = req.body;
    if (!name || !database_name || !username || !host) {
      return res.status(400).json({ success: false, error: 'Name, host, database name, and username are required.' });
    }

    const id = storage.saveDbConfig({
      name,
      type: type || 'postgres',
      host,
      port: parseInt(port, 10) || (type === 'mysql' ? 3306 : 5432),
      database_name,
      username,
      password: password || '',
      ssl: Boolean(ssl),
      is_active: is_active !== undefined ? Boolean(is_active) : true,
    });

    res.json({ success: true, id, message: 'Database configuration saved successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put('/db-configs/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const existing = storage.getDbConfigById(id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Configuration not found.' });
    }

    const { name, type, host, port, database_name, username, password, ssl, is_active } = req.body;
    storage.saveDbConfig({
      id: Number(id),
      name: name || existing.name,
      type: type || existing.type,
      host: host || existing.host,
      port: port ? parseInt(port, 10) : existing.port,
      database_name: database_name || existing.database_name,
      username: username || existing.username,
      password: password !== undefined && password !== '********' ? password : existing.password,
      ssl: ssl !== undefined ? Boolean(ssl) : existing.ssl,
      is_active: is_active !== undefined ? Boolean(is_active) : existing.is_active,
    });

    res.json({ success: true, message: 'Database configuration updated successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/db-configs/:id', (req, res) => {
  try {
    storage.deleteDbConfig(req.params.id);
    res.json({ success: true, message: 'Database configuration deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/db-configs/test', async (req, res) => {
  try {
    const { id, type, host, port, database_name, username, password, ssl } = req.body;
    let targetConfig = null;

    if (id) {
      targetConfig = storage.getDbConfigById(id);
      if (!targetConfig) return res.status(404).json({ success: false, error: 'Config not found.' });
      if (password && password !== '********') targetConfig.password = password;
    } else {
      targetConfig = { type, host, port, database_name, username, password, ssl };
    }

    try {
      const testResult = await DatabaseStreamer.testConnection(targetConfig);
      if (id) storage.updateDbTestStatus(id, 'SUCCESS');
      res.json({ success: true, result: testResult });
    } catch (testErr) {
      if (id) storage.updateDbTestStatus(id, 'FAILED', testErr.message);
      res.status(400).json({ success: false, error: testErr.message });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Google Drive Configuration Endpoints
router.get('/gdrive-config', (req, res) => {
  try {
    const gdrive = storage.getGDriveConfig();
    if (!gdrive) {
      return res.json({ success: true, data: null });
    }

    res.json({
      success: true,
      data: {
        id: gdrive.id,
        auth_type: gdrive.auth_type,
        folder_id: gdrive.folder_id,
        folder_name: gdrive.folder_name,
        is_active: gdrive.is_active,
        test_status: gdrive.test_status,
        last_tested_at: gdrive.last_tested_at,
        has_service_account: Boolean(gdrive.service_account_json),
        has_oauth: Boolean(gdrive.refresh_token),
        client_id: gdrive.client_id ? 'Configured' : '',
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/gdrive-config', async (req, res) => {
  try {
    const { auth_type, service_account_json, client_id, client_secret, refresh_token, folder_id } = req.body;
    if (!folder_id) {
      return res.status(400).json({ success: false, error: 'Google Drive Folder ID is required.' });
    }

    const id = storage.saveGDriveConfig({
      auth_type: auth_type || 'service_account',
      service_account_json: service_account_json || '',
      client_id: client_id || '',
      client_secret: client_secret || '',
      refresh_token: refresh_token || '',
      folder_id,
    });

    res.json({ success: true, id, message: 'Google Drive configuration saved.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/gdrive-config/test', async (req, res) => {
  try {
    const { auth_type, service_account_json, client_id, client_secret, refresh_token, folder_id } = req.body;
    let customConfig = null;

    if (folder_id) {
      const active = storage.getGDriveConfig() || {};
      customConfig = {
        auth_type: auth_type || active.auth_type || 'service_account',
        service_account_json: service_account_json || active.service_account_json || '',
        client_id: client_id || active.client_id || '',
        client_secret: client_secret || active.client_secret || '',
        refresh_token: refresh_token || active.refresh_token || '',
        folder_id,
      };
    }

    try {
      const testResult = await GoogleDriveService.testConnection(customConfig);
      const active = storage.getGDriveConfig();
      if (active) {
        storage.updateGDriveTestStatus(active.id, 'SUCCESS', testResult.folderName);
      }
      res.json({ success: true, result: testResult });
    } catch (testErr) {
      const active = storage.getGDriveConfig();
      if (active) {
        storage.updateGDriveTestStatus(active.id, 'FAILED', null, testErr.message);
      }
      res.status(400).json({ success: false, error: testErr.message });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Backup Execution & History Endpoints
router.get('/backups', (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 50;
    const history = storage.getBackupHistory(limit);
    res.json({ success: true, data: history });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Trigger an immediate manual backup stream
router.post('/backups/trigger/:dbId', async (req, res) => {
  try {
    const dbId = parseInt(req.params.dbId, 10);
    const dbConfig = storage.getDbConfigById(dbId);
    if (!dbConfig) {
      return res.status(404).json({ success: false, error: 'Database configuration not found.' });
    }

    // Start streaming asynchronously and return immediate confirmation, or wait for stream
    const wait = req.query.wait === 'true';
    if (wait) {
      const result = await DatabaseStreamer.streamBackup(dbId);
      res.json({ success: true, result });
    } else {
      // Async trigger
      DatabaseStreamer.streamBackup(dbId)
        .then(async (result) => {
          console.log(`[Manual Trigger] Backup completed: #${result.id}`);
          const autoVerify = storage.getSetting('auto_verify_integrity', 'true') === 'true';
          if (autoVerify) {
            try { await RestoreTestService.verifyBackupIntegrity(result.id); } catch (e) {}
          }
        })
        .catch((e) => console.error('[Manual Trigger] Backup failed:', e.message));

      res.json({ success: true, message: `Backup stream initiated for ${dbConfig.name}. Check History for live progress.` });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Restore Test & Integrity Verification Endpoints
router.get('/restore-tests', (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 50;
    const tests = storage.getRestoreTests(limit);
    res.json({ success: true, data: tests });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Trigger a restore integrity test on a specific backup
router.post('/restore-tests/trigger/:backupId', async (req, res) => {
  try {
    const backupId = parseInt(req.params.backupId, 10);
    const backup = storage.getBackupById(backupId);
    if (!backup) {
      return res.status(404).json({ success: false, error: 'Backup record not found.' });
    }

    const { sandboxRestore, testDb } = req.body || {};

    const wait = req.query.wait === 'true';
    if (wait) {
      const result = await RestoreTestService.verifyBackupIntegrity(backupId, { sandboxRestore, testDb });
      res.json({ success: true, result });
    } else {
      RestoreTestService.verifyBackupIntegrity(backupId, { sandboxRestore, testDb })
        .then(r => console.log(`[Manual Test] Integrity verification completed for #${backupId}: ${r.status}`))
        .catch(e => console.error(`[Manual Test] Integrity verification failed for #${backupId}:`, e.message));

      res.json({ success: true, message: `Restoration integrity verification initiated for backup #${backupId}.` });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// System Settings Endpoints (Cron schedule, auto-verify)
router.get('/settings', (req, res) => {
  try {
    const settings = storage.getAllSettings();
    res.json({ success: true, data: settings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/settings', (req, res) => {
  try {
    const { cron_schedule, auto_verify_integrity, retention_days } = req.body;

    if (cron_schedule) {
      scheduler.reschedule(cron_schedule);
    }

    if (auto_verify_integrity !== undefined) {
      storage.setSetting('auto_verify_integrity', String(auto_verify_integrity));
    }

    if (retention_days !== undefined) {
      storage.setSetting('retention_days', String(retention_days));
    }

    res.json({ success: true, message: 'Settings updated successfully.', settings: storage.getAllSettings() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
