-- Migration 001: Update user_id from BIGINT to UUID to support LangChain integration

-- Check if table exists as whatsapp_sessions_wapi or whatsapp_user
DO $$
BEGIN
    -- Try to add UUID columns to whatsapp_sessions_wapi if it exists
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'whatsapp_sessions_wapi') THEN
        -- Add new UUID column
        ALTER TABLE whatsapp_sessions_wapi ADD COLUMN IF NOT EXISTS user_id_uuid UUID;

        -- Add langchain_user_id column for explicit LangChain integration
        ALTER TABLE whatsapp_sessions_wapi ADD COLUMN IF NOT EXISTS langchain_user_id UUID;

        -- Migrate existing BIGINT user_id to UUID (if needed)
        UPDATE whatsapp_sessions_wapi SET user_id_uuid = gen_random_uuid() WHERE user_id_uuid IS NULL;

        -- Add comments
        COMMENT ON COLUMN whatsapp_sessions_wapi.user_id IS 'Legacy user_id (BIGINT) for backward compatibility';
        COMMENT ON COLUMN whatsapp_sessions_wapi.user_id_uuid IS 'New user_id (UUID) for LangChain integration';
        COMMENT ON COLUMN whatsapp_sessions_wapi.langchain_user_id IS 'Direct reference to LangChain users table';

        -- Add indexes for UUID columns
        CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_wapi_user_id_uuid ON whatsapp_sessions_wapi(user_id_uuid);
        CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_wapi_langchain_user_id ON whatsapp_sessions_wapi(langchain_user_id);

        RAISE NOTICE 'Updated whatsapp_sessions_wapi table with UUID columns';
    END IF;

    -- Also update whatsapp_user table if it exists (current code base)
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'whatsapp_user') THEN
        -- Add new UUID column
        ALTER TABLE whatsapp_user ADD COLUMN IF NOT EXISTS user_id_uuid UUID;

        -- Add langchain_user_id column for explicit LangChain integration
        ALTER TABLE whatsapp_user ADD COLUMN IF NOT EXISTS langchain_user_id UUID;

        -- Migrate existing BIGINT user_id to UUID (if needed)
        UPDATE whatsapp_user SET user_id_uuid = gen_random_uuid() WHERE user_id_uuid IS NULL;

        -- Add comments
        COMMENT ON COLUMN whatsapp_user.user_id IS 'Legacy user_id (BIGINT) for backward compatibility';
        COMMENT ON COLUMN whatsapp_user.user_id_uuid IS 'New user_id (UUID) for LangChain integration';
        COMMENT ON COLUMN whatsapp_user.langchain_user_id IS 'Direct reference to LangChain users table';

        -- Add indexes for UUID columns
        CREATE INDEX IF NOT EXISTS idx_whatsapp_user_user_id_uuid ON whatsapp_user(user_id_uuid);
        CREATE INDEX IF NOT EXISTS idx_whatsapp_user_langchain_user_id ON whatsapp_user(langchain_user_id);

        RAISE NOTICE 'Updated whatsapp_user table with UUID columns';
    END IF;
END $$;