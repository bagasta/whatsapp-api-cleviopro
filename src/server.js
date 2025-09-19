const app = require('./app');
const env = require('./config/env');
const logger = require('./utils/logger');
const { ensureSchema } = require('./database');
const { bootstrapSessions } = require('./services/sessionBootstrap');
const tempFileManager = require('./services/tempFileManager');

async function bootstrap() {
  await ensureSchema();
  await tempFileManager.init();
  await bootstrapSessions();

  app.locals.startTime = new Date();

  app.listen(env.port, () => {
    logger.info(`Server listening on port ${env.port}`);
  });
}

bootstrap().catch((err) => {
  logger.error({ err }, 'Failed to start application');
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'Unhandled rejection');
});

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception');
});
