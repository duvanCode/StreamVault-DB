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

// Authentication Status Endpoint (No auth required)
router.get('/auth/status', (req, res) => {
  const requiresAuth = Boolean(config.ACCESS_KEY);
  if (!requiresAuth) {
    return res.json({ requiresAuth: false, authenticated: true });
  }

  const provided = req.headers['x-access-key'] || (req.headers.authorization && req.headers.authorization.replace(/^Bearer\s+/i, '').trim());
  const token = Buffer.from(config.ACCESS_KEY).toString('base64');
  const authenticated = provided === config.ACCESS_KEY || provided === token;

  res.json({ requiresAuth: true, authenticated });
});

// Authentication Login Endpoint (Verify Access Key)
router.post('/auth/login', (req, res) => {
  if (!config.ACCESS_KEY) {
    return res.json({ success: true, message: 'Autenticación no requerida.' });
  }

  const { key } = req.body || {};
  const cleanKey = (key || '').trim();

  if (cleanKey === config.ACCESS_KEY) {
    const token = Buffer.from(config.ACCESS_KEY).toString('base64');
    return res.json({
      success: true,
      token,
      message: 'Acceso autorizado.',
    });
  }

  return res.status(401).json({
    success: false,
    error: 'Llave de acceso incorrecta.',
  });
});

// Google OAuth 2.0 Public Redirect Callback
router.get('/gdrive/oauth/callback', async (req, res) => {
  const { code, error, state } = req.query;

  if (error) {
    return res.status(400).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Error de Autenticación - StreamVault DB</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b1326; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .card { background: #111e38; border: 1px solid #ef4444; border-radius: 12px; padding: 2.5rem; max-width: 460px; text-align: center; }
          h2 { color: #ef4444; margin-top: 0; }
          p { color: #94a3b8; line-height: 1.5; }
          .btn { margin-top: 1.5rem; background: #ef4444; color: #fff; padding: 0.75rem 1.5rem; border-radius: 8px; border: none; cursor: pointer; font-weight: bold; }
        </style>
      </head>
      <body>
        <div class="card">
          <div style="font-size: 3rem; margin-bottom: 1rem;">❌</div>
          <h2>Autorización Cancelada</h2>
          <p>Google reportó un error: <strong>${error}</strong></p>
          <button class="btn" onclick="window.close()">Cerrar Ventana</button>
        </div>
      </body>
      </html>
    `);
  }

  if (!code) {
    return res.status(400).send('No se recibió código de autorización de Google.');
  }

  try {
    const active = storage.getGDriveConfig() || {};
    let redirectUri = '';
    if (state) {
      try {
        const decoded = JSON.parse(Buffer.from(state, 'base64url').toString('utf-8'));
        if (decoded.redirectUri) redirectUri = decoded.redirectUri;
      } catch (e) {}
    }

    if (!redirectUri) {
      const proto = req.headers['x-forwarded-proto'] || req.protocol;
      const host = req.headers['x-forwarded-host'] || req.get('host');
      redirectUri = `${proto}://${host}/api/gdrive/oauth/callback`;
    }

    if (!active.client_id || !active.client_secret) {
      return res.status(400).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <title>Faltan Credenciales - StreamVault DB</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b1326; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            .card { background: #111e38; border: 1px solid #f59e0b; border-radius: 12px; padding: 2.5rem; max-width: 460px; text-align: center; }
            h2 { color: #f59e0b; margin-top: 0; }
            p { color: #94a3b8; line-height: 1.5; }
            .btn { margin-top: 1.5rem; background: #38bdf8; color: #0b1326; padding: 0.75rem 1.5rem; border-radius: 8px; border: none; cursor: pointer; font-weight: bold; }
          </style>
        </head>
        <body>
          <div class="card">
            <div style="font-size: 3rem; margin-bottom: 1rem;">⚠️</div>
            <h2>Falta Client ID o Client Secret</h2>
            <p>Por favor ingresa primero el Client ID y Client Secret en el panel de StreamVault antes de conectar.</p>
            <button class="btn" onclick="window.close()">Cerrar Ventana</button>
          </div>
        </body>
        </html>
      `);
    }

    const tokens = await GoogleDriveService.exchangeCodeForTokens({
      clientId: active.client_id,
      clientSecret: active.client_secret,
      redirectUri,
      code,
    });

    if (tokens.refresh_token) {
      storage.saveGDriveConfig({
        ...active,
        auth_type: 'oauth',
        refresh_token: tokens.refresh_token,
      });
    }

    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Google Drive Conectado - StreamVault DB</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b1326; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .card { background: #111e38; border: 1px solid #10b981; border-radius: 12px; padding: 2.5rem; max-width: 480px; text-align: center; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
          h2 { color: #10b981; margin-top: 0; margin-bottom: 0.5rem; }
          p { color: #94a3b8; line-height: 1.5; font-size: 0.95rem; }
          .badge { display: inline-block; background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid #10b981; padding: 4px 12px; border-radius: 9999px; font-size: 0.8rem; font-weight: bold; margin-bottom: 1rem; }
          .btn { display: inline-block; margin-top: 1.5rem; background: #38bdf8; color: #0b1326; padding: 0.75rem 1.5rem; border-radius: 8px; font-weight: bold; cursor: pointer; border: none; }
        </style>
      </head>
      <body>
        <div class="card">
          <div style="font-size: 3.5rem; margin-bottom: 0.75rem;">⚡</div>
          <span class="badge">OAuth 2.0 Conectado</span>
          <h2>¡Google Drive Vinculado!</h2>
          <p>Tu cuenta personal ha sido autorizada correctamente. El token de actualización (Refresh Token) se configuró de forma segura.</p>
          <p style="font-size: 0.85rem; color: #64748b;">Esta ventana se cerrará automáticamente...</p>
          <button class="btn" onclick="window.close()">Cerrar Ventana</button>
        </div>
        <script>
          if (window.opener) {
            window.opener.postMessage({ type: 'GDRIVE_OAUTH_SUCCESS', refreshToken: '${tokens.refresh_token || ""}' }, '*');
            setTimeout(() => window.close(), 1600);
          }
        </script>
      </body>
      </html>
    `);
  } catch (err) {
    return res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <body style="background:#0b1326; color:#ef4444; font-family:sans-serif; padding:2rem; text-align:center;">
        <h2>Error al intercambiar autorización con Google</h2>
        <pre style="background:#111e38; padding:1rem; border-radius:8px; color:#f8fafc; text-align:left; max-width:600px; margin: 0 auto;">${err.message}</pre>
        <br>
        <button onclick="window.close()" style="background:#38bdf8; border:none; padding:10px 20px; border-radius:6px; cursor:pointer; font-weight:bold;">Cerrar Ventana</button>
      </body>
      </html>
    `);
  }
});

// Access Key Protection Middleware for all other API endpoints
router.use((req, res, next) => {
  // If no ACCESS_KEY is configured in .env, permit all access
  if (!config.ACCESS_KEY) {
    return next();
  }

  // Exempt public callback
  if (req.path === '/gdrive/oauth/callback') {
    return next();
  }

  const headerKey = req.headers['x-access-key'];
  const authHeader = req.headers.authorization;
  let provided = headerKey;
  if (!provided && authHeader) {
    provided = authHeader.replace(/^Bearer\s+/i, '').trim();
  }

  const token = Buffer.from(config.ACCESS_KEY).toString('base64');
  if (provided === config.ACCESS_KEY || provided === token) {
    return next();
  }

  return res.status(401).json({
    success: false,
    requiresAuth: true,
    error: 'Acceso no autorizado. Se requiere llave de acceso válida.',
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
        client_id: gdrive.client_id || '',
        has_client_secret: Boolean(gdrive.client_secret),
        has_refresh_token: Boolean(gdrive.refresh_token),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post('/gdrive-config', async (req, res) => {
  try {
    const { auth_type, service_account_json, client_id, client_secret, refresh_token, folder_id } = req.body;

    const id = storage.saveGDriveConfig({
      auth_type: auth_type || 'oauth',
      service_account_json: service_account_json !== undefined ? service_account_json : undefined,
      client_id: client_id !== undefined ? client_id : undefined,
      client_secret: client_secret !== undefined ? client_secret : undefined,
      refresh_token: refresh_token !== undefined ? refresh_token : undefined,
      folder_id: folder_id || 'root',
    });

    res.json({ success: true, id, message: 'Configuración de Google Drive guardada.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Generate Google OAuth 2.0 Auth URL
router.post('/gdrive/oauth/url', (req, res) => {
  try {
    const { client_id, client_secret, redirect_uri, folder_id } = req.body;
    if (!client_id) {
      return res.status(400).json({ success: false, error: 'Client ID es requerido para conectar con Google.' });
    }

    const current = storage.getGDriveConfig() || {};
    // Pre-save client_id, client_secret and folder_id before redirecting
    storage.saveGDriveConfig({
      auth_type: 'oauth',
      client_id,
      client_secret: client_secret || current.client_secret || '',
      folder_id: folder_id || current.folder_id || 'root',
    });

    const state = Buffer.from(JSON.stringify({ redirectUri: redirect_uri })).toString('base64url');
    const authUrl = GoogleDriveService.generateAuthUrl({
      clientId: client_id,
      clientSecret: client_secret || current.client_secret || '',
      redirectUri,
      state,
    });

    res.json({ success: true, url: authUrl });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Manual exchange code for tokens
router.post('/gdrive/oauth/exchange', async (req, res) => {
  try {
    const { client_id, client_secret, redirect_uri, code } = req.body;
    if (!client_id || !client_secret || !code) {
      return res.status(400).json({ success: false, error: 'Client ID, Client Secret y Código de autorización son requeridos.' });
    }

    const tokens = await GoogleDriveService.exchangeCodeForTokens({
      clientId,
      clientSecret,
      redirectUri,
      code,
    });

    if (tokens.refresh_token) {
      storage.saveGDriveConfig({
        auth_type: 'oauth',
        client_id,
        client_secret,
        refresh_token: tokens.refresh_token,
      });
    }

    res.json({ success: true, tokens, message: 'Tokens obtenidos y guardados exitosamente.' });
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
