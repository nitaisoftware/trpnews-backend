// src/index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const logger = require('./utils/logger');
const { runFetchJob } = require('./services/rssFetcher');

const app = express();
const PORT = process.env.PORT || 4000;
const INTERVAL = parseInt(process.env.FETCH_INTERVAL_MINUTES) || 15;

// ── Security & Middleware ──────────────────────────────
app.use(helmet());
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'https://trpnews.in',
    'http://localhost:3000',
  ],
  credentials: true,
}));
app.use(express.json());

// Rate limiting — protect against abuse
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
const adminLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 50 });
app.use('/api/news', apiLimiter);
app.use('/api/admin', adminLimiter);

// ── Routes ─────────────────────────────────────────────
app.use('/api/news',  require('./routes/news'));
app.use('/api/admin', require('./routes/admin'));

// Health check
app.get('/health', (req, res) => res.json({
  status: 'ok',
  service: 'TRPNews Backend',
  time: new Date().toISOString(),
}));

// ── Cron Job ───────────────────────────────────────────
// Fetch news every N minutes (default: 15)
cron.schedule(`*/${INTERVAL} * * * *`, async () => {
  logger.info(`⏰ Cron: Starting fetch (every ${INTERVAL} min)`);
  try {
    await runFetchJob();
  } catch (err) {
    logger.error(`Cron fetch error: ${err.message}`);
  }
});

// ── Start ──────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info(`🚀 TRPNews backend running on port ${PORT}`);
  logger.info(`📡 RSS fetch scheduled every ${INTERVAL} minutes`);
  // Run initial fetch on startup (after 10s delay)
  setTimeout(() => {
    logger.info('Running initial fetch on startup...');
    runFetchJob().catch(err => logger.error('Startup fetch error:', err));
  }, 10000);
});

module.exports = app;
