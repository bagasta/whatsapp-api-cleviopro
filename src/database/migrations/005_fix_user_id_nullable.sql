-- Migration 005: Make user_id nullable to support UUID users

-- Update whatsapp_user table to allow NULL user_id for UUID users
ALTER TABLE whatsapp_user ALTER COLUMN user_id DROP NOT NULL;

-- Update whatsapp_sessions_wapi if it exists
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'whatsapp_sessions_wapi' AND column_name = 'user_id') THEN
        ALTER TABLE whatsapp_sessions_wapi ALTER COLUMN user_id DROP NOT NULL;
        RAISE NOTICE 'Updated whatsapp_sessions_wapi.user_id to be nullable';
    END IF;
END $$;

-- Add comment for clarification
COMMENT ON COLUMN whatsapp_user.user_id IS 'Legacy user_id (BIGINT) for backward compatibility. NULL for UUID users (stored in user_id_uuid)';