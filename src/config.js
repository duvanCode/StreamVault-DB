require('dotenv').config();
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

module.exports = {
  PORT: parseInt(process.env.PORT || process.env.APP_PORT || process.env.DOKPLOY_PORT, 10) || 3000,
  HOST: process.env.HOST || '0.0.0.0',
  DATA_DIR,
  DB_FILE: path.join(DATA_DIR, 'backup_service.db'),
  BACKUP_CRON: process.env.BACKUP_CRON || '0 2 * * *', // Default daily at 2:00 AM
  TIMEZONE: process.env.TIMEZONE || 'UTC',

  // Optional Dashboard basic authentication
  DASHBOARD_USERNAME: process.env.DASHBOARD_USERNAME || '',
  DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD || '',

  // Default credentials loaded from .env (can also be configured via Web UI)
  DEFAULT_DB: {
    type: process.env.DEFAULT_DB_TYPE || 'postgres', // 'postgres' or 'mysql'
    host: process.env.DEFAULT_DB_HOST || 'localhost',
    port: parseInt(process.env.DEFAULT_DB_PORT, 10) || (process.env.DEFAULT_DB_TYPE === 'mysql' ? 3306 : 5432),
    name: process.env.DEFAULT_DB_NAME || '',
    user: process.env.DEFAULT_DB_USER || '',
    password: process.env.DEFAULT_DB_PASSWORD || '',
    ssl: process.env.DEFAULT_DB_SSL === 'true',
  },

  // Default Google Drive configuration from .env
  GDRIVE: {
    folderId: process.env.GOOGLE_DRIVE_FOLDER_ID || '',
    serviceAccountKey: process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '', // Raw JSON string or file path
    serviceAccountFile: process.env.GOOGLE_SERVICE_ACCOUNT_FILE || '',
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
    refreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN || '',
  },

  // Sandbox / Test restore database configuration (optional)
  TEST_DB: {
    enabled: process.env.TEST_DB_ENABLED === 'true',
    type: process.env.TEST_DB_TYPE || 'postgres',
    host: process.env.TEST_DB_HOST || '',
    port: parseInt(process.env.TEST_DB_PORT, 10) || 5432,
    name: process.env.TEST_DB_NAME || '',
    user: process.env.TEST_DB_USER || '',
    password: process.env.TEST_DB_PASSWORD || '',
  }
};
