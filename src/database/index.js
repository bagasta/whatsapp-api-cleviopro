const pool = require('./pool');
const logger = require('../utils/logger');

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_user (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      agent_id VARCHAR(255) NOT NULL,
      api_key TEXT NOT NULL,
      session_name VARCHAR(255) NOT NULL,
      endpoint_url_run TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (agent_id)
    );
  `);

  await pool.query(`
    ALTER TABLE whatsapp_user
    ADD COLUMN IF NOT EXISTS status VARCHAR(50) NOT NULL DEFAULT 'awaiting_qr';
  `);

  await pool.query(`
    ALTER TABLE whatsapp_user
    ADD COLUMN IF NOT EXISTS last_connected_at TIMESTAMPTZ;
  `);

  await pool.query(`
    ALTER TABLE whatsapp_user
    ADD COLUMN IF NOT EXISTS last_disconnected_at TIMESTAMPTZ;
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'trg_whatsapp_user_updated_at'
      ) THEN
        CREATE TRIGGER trg_whatsapp_user_updated_at
        BEFORE UPDATE ON whatsapp_user
        FOR EACH ROW
        EXECUTE FUNCTION set_updated_at();
      END IF;
    END;
    $$;
  `);

  logger.info('Database schema verified');
}

module.exports = { pool, ensureSchema };
