const { Pool } = require('pg');
const config = require('../config/env');
const logger = require('../utils/logger');

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected database error');
});

module.exports = pool;
