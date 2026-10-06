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
