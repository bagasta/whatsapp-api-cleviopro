const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

async function runMigrations(pool) {
  const migrationsDir = path.join(__dirname, 'migrations');

  try {
    // Create migrations_log table if not exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS migrations_log (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) NOT NULL UNIQUE,
        executed_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Get executed migrations
    const { rows: executedMigrations } = await pool.query(
      'SELECT filename FROM migrations_log ORDER BY filename'
    );
    const executedFiles = executedMigrations.map(m => m.filename);

    // Get all migration files
    const migrationFiles = fs.readdirSync(migrationsDir)
      .filter(file => file.endsWith('.sql'))
      .sort();

    // Run pending migrations
    for (const file of migrationFiles) {
      if (!executedFiles.includes(file)) {
        logger.info({ file }, 'Running migration');

        const migrationSQL = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

        await pool.query('BEGIN');
        try {
          await pool.query(migrationSQL);
          await pool.query(
            'INSERT INTO migrations_log (filename) VALUES ($1)',
            [file]
          );
          await pool.query('COMMIT');

          logger.info({ file }, 'Migration completed successfully');
        } catch (error) {
          await pool.query('ROLLBACK');
          logger.error({ file, error: error.message }, 'Migration failed');
          throw error;
        }
      } else {
        logger.debug({ file }, 'Migration already executed, skipping');
      }
    }

    logger.info('All migrations completed successfully');
  } catch (error) {
    logger.error({ error: error.message }, 'Migration runner failed');
    throw error;
  }
}

// Run migrations if this file is executed directly
if (require.main === module) {
  const { pool } = require('./pool');
  runMigrations(pool)
    .then(() => {
      logger.info('Migration process completed');
      process.exit(0);
    })
    .catch((error) => {
      logger.error({ error: error.message }, 'Migration process failed');
      process.exit(1);
    });
}

module.exports = { runMigrations };