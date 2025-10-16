-- Migration 004: Fix api_key table to support both UUID and BIGINT

-- Drop existing api_key table and recreate with flexible user_id
DROP TABLE IF EXISTS api_key CASCADE;

-- Recreate api_key table with flexible user_id that can store both UUID and BIGINT
CREATE TABLE api_key (
  id SERIAL PRIMARY KEY,
  user_id TEXT, -- Store as TEXT to support both UUID and BIGINT
  key_hash TEXT,
  expires_at TIMESTAMPTZ,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create unique constraint on user_id
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_key_user_id ON api_key(user_id);

-- Insert test data for UUID users
INSERT INTO api_key (user_id, key_hash, expires_at, active)
VALUES
  ('13e6f834-297d-4ebf-9980-c950f78ea0ee', 'test-uuid-key-1', NOW() + INTERVAL '1 year', true),
  ('353271b0-87bd-45a9-8840-a8ad40665b63', 'test-uuid-key-2', NOW() + INTERVAL '1 year', true)
ON CONFLICT (user_id) DO NOTHING;

-- Insert test data for BIGINT users (legacy)
INSERT INTO api_key (user_id, key_hash, expires_at, active)
VALUES
  ('123456789', 'test-bigint-key-1', NOW() + INTERVAL '1 year', true),
  ('987654321', 'test-bigint-key-2', NOW() + INTERVAL '1 year', true)
ON CONFLICT (user_id) DO NOTHING;

-- Add comments
COMMENT ON TABLE api_key IS 'API key management table supporting both UUID and BIGINT user IDs';
COMMENT ON COLUMN api_key.user_id IS 'User ID (can be UUID or BIGINT stored as TEXT)';