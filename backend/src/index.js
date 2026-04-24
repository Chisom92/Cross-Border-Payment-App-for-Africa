require('dotenv').config();

const validateEnv = require('./utils/validateEnv');
const logger = require('./utils/logger');

validateEnv();

// Configure VAPID for Web Push using native service (no external dependency)
const webpush = require('./services/webpush');

const db = require('./db');
const app = require('./app');
const { initStreams } = require('./services/horizonWorker');
const { syncOfferEvents } = require('./jobs/syncOfferEvents');
const ledgerListener = require('./services/ledgerListener');
const { Server: SocketIOServer } = require('socket.io');
const jwt = require('jsonwebtoken');

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

// Socket.IO — scoped per authenticated user (JWT-based room)
const io = new SocketIOServer(server, {
  cors: { origin: process.env.FRONTEND_URL, credentials: true },
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    socket.userId = payload.userId;
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

io.on('connection', async (socket) => {
  try {
    const { rows } = await db.query(
      `SELECT w.public_key FROM wallets w WHERE w.user_id = $1`,
      [socket.userId]
    );
    for (const row of rows) {
      socket.join(row.public_key);
      ledgerListener.startStreamForAccount(row.public_key);
      ledgerListener.startPaymentStream(row.public_key);
    }
    logger.info('Socket connected', { userId: socket.userId });
  } catch (err) {
    logger.warn('Socket setup error', { error: err.message });
  }

  socket.on('disconnect', () => {
    logger.info('Socket disconnected', { userId: socket.userId });
  });
});

ledgerListener.setSocketIO(io);

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
