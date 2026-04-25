require('dotenv').config();

const validateEnv = require('./utils/validateEnv');
const logger = require('./utils/logger');

validateEnv();

// Configure VAPID for Web Push using native service (no external dependency)
const webpush = require('./services/webpush');

const db = require('./db');
const app = require('./app');
const { initStreams } = require('./services/horizonWorker');
const { detectTestnetReset } = require('./services/stellar');
const { syncOfferEvents } = require('./jobs/syncOfferEvents');

const PORT = process.env.PORT || 5000;
const SHUTDOWN_TIMEOUT_MS = 30_000;

const server = app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`, { port: PORT });
  initStreams();

  // Warn if testnet was reset since last startup
  if (process.env.NODE_ENV !== 'production') {
    detectTestnetReset().then((reset) => {
      if (reset) {
        logger.warn('⚠️  Stellar testnet reset detected at startup. Run POST /api/dev/handle-testnet-reset to recover.');
      }
    }).catch(() => {});
  }
  // Sync DEX offer events every 2 minutes
  const OFFER_SYNC_INTERVAL_MS = parseInt(process.env.OFFER_SYNC_INTERVAL_MS || '120000', 10);
  setInterval(() => {
    syncOfferEvents().catch((err) =>
      logger.warn('syncOfferEvents interval error', { error: err.message })
    );
  }, OFFER_SYNC_INTERVAL_MS);
});

async function shutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully`);

  const forceExit = setTimeout(() => {
    logger.error('Shutdown timeout exceeded — forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  server.close(async () => {
    clearTimeout(forceExit);
    try {
      await db.pool.end();
      logger.info('DB pool closed');
    } catch (err) {
      logger.error('Error closing DB pool', { message: err.message });
    }
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { app, server, shutdown };
