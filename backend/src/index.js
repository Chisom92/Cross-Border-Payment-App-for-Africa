require('dotenv').config();

const Sentry = require('@sentry/node');

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
  enabled: !!process.env.SENTRY_DSN,
  beforeSend(event) {
    // Scrub sensitive fields from request body
    if (event.request?.data) {
      const scrubFields = ['password', 'secret', 'privateKey', 'token', 'pin', 'encryptedSecretKey'];
      scrubFields.forEach((f) => {
        if (event.request.data[f]) event.request.data[f] = '[Filtered]';
      });
    }
    // Remove authorization header
    if (event.request?.headers?.authorization) {
      event.request.headers.authorization = '[Filtered]';
    }
    return event;
  },
});

const validateEnv = require('./utils/validateEnv');
const logger = require('./utils/logger');

validateEnv();

// Configure VAPID for Web Push using native service (no external dependency)
const webpush = require('./services/webpush');

const db = require('./db');
const app = require('./app');
const { initStreams } = require('./services/horizonWorker');
const { syncOfferEvents } = require('./jobs/syncOfferEvents');

const PORT = process.env.PORT || 5000;
const SHUTDOWN_TIMEOUT_MS = 30_000;

const server = app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`, { port: PORT });
  initStreams();

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

process.on('unhandledRejection', (reason) => {
  Sentry.captureException(reason);
});
process.on('uncaughtException', (error) => {
  Sentry.captureException(error);
});

module.exports = { app, server, shutdown };
