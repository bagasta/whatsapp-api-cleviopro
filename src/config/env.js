const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: process.env.ENV_PATH || path.resolve(process.cwd(), '.env') });

const requiredEnv = ['DATABASE_URL', 'APP_BASE_URL'];

const missing = requiredEnv.filter((name) => !process.env[name]);
if (missing.length) {
  console.warn(`Missing environment variables: ${missing.join(', ')}`);
}

module.exports = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  appBaseUrl: process.env.APP_BASE_URL || 'http://localhost:8000',
  aiBackendBaseUrl: process.env.AI_BACKEND_URL || null,
  databaseUrl: process.env.DATABASE_URL,
  tempDir: process.env.TEMP_DIR || path.resolve(process.cwd(), 'temp'),
  qrExpirationMinutes: parseInt(process.env.QR_EXPIRATION_MINUTES || '5', 10),
  sessionCleanupIntervalMinutes: parseInt(process.env.SESSION_CLEANUP_INTERVAL_MINUTES || '60', 10),
  defaultOpenAiApiKey: process.env.DEFAULT_OPENAI_API_KEY || null,
  aiRequestTimeoutMs: parseInt(process.env.AI_REQUEST_TIMEOUT_MS || '120000', 10),
};
