const express = require('express');
const path = require('path');
const cors = require('cors');
const config = require('./config');
const storage = require('./db/storage');
const scheduler = require('./services/scheduler');
const apiRoutes = require('./routes/api');

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Optional Dashboard basic authentication if configured
if (config.DASHBOARD_PASSWORD) {
  app.use((req, res, next) => {
    // Exclude healthcheck from auth so Dokploy and Docker monitoring works seamlessly
    if (req.path === '/api/health') return next();

    const authHeader = req.headers.authorization;
    if (!authHeader) {
      res.setHeader('WWW-Authenticate', 'Basic realm="StreamVault Dashboard"');
      return res.status(401).send('Authentication required.');
    }

    const auth = Buffer.from(authHeader.split(' ')[1] || '', 'base64').toString().split(':');
    const user = auth[0];
    const pass = auth[1];

    const expectedUser = config.DASHBOARD_USERNAME || 'admin';
    const expectedPass = config.DASHBOARD_PASSWORD;

    if (user === expectedUser && pass === expectedPass) {
      return next();
    }

    res.setHeader('WWW-Authenticate', 'Basic realm="StreamVault Dashboard"');
    return res.status(401).send('Access denied.');
  });
}

// Serve API routes
app.use('/api', apiRoutes);

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Fallback to index.html for SPA-like navigation
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Startup sequence
function bootstrap() {
  console.log('--------------------------------------------------');
  console.log(' 🚀 StreamVault DB - Backup Streamer & Restore Service');
  console.log('--------------------------------------------------');

  // 1. Initialize persistent storage
  storage.init();
  console.log(`[Storage] Initialized persistent data directory at: ${config.DATA_DIR}`);

  // 2. Start automated backup scheduler
  scheduler.start();

  // 3. Start Web Server
  app.listen(config.PORT, config.HOST, () => {
    console.log(`[Server] Web Dashboard running on: http://${config.HOST}:${config.PORT}`);
    console.log(`[Server] Dokploy Healthcheck: http://${config.HOST}:${config.PORT}/api/health`);
    console.log('--------------------------------------------------');
  });
}

bootstrap();
