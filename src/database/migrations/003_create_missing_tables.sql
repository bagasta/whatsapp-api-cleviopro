-- Migration 003: Create missing tables that are referenced in the code

-- Create api_key table if it doesn't exist
CREATE TABLE IF NOT EXISTS api_key (
  id SERIAL PRIMARY KEY,
  user_id BIGINT,
  key_hash TEXT,
  expires_at TIMESTAMPTZ,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert some test data for api_key table
INSERT INTO api_key (user_id, key_hash, expires_at, active)
VALUES
  (123456789, 'test-api-key-hash', NOW() + INTERVAL '1 year', true),
  (987654321, 'another-test-key', NOW() + INTERVAL '1 year', true)
ON CONFLICT DO NOTHING;

-- Add comments
COMMENT ON TABLE api_key IS 'API key management table';
COMMENT ON COLUMN api_key.key_hash IS 'Hashed API key value';