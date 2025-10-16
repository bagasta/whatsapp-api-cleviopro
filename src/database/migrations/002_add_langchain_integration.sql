-- Migration 002: Add LangChain integration tables and columns

-- Enhanced WhatsApp tables for LangChain integration
DO $$
BEGIN
    -- Update whatsapp_sessions_wapi if it exists
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'whatsapp_sessions_wapi') THEN
        ALTER TABLE whatsapp_sessions_wapi
          ADD COLUMN IF NOT EXISTS langchain_agent_id UUID,
          ADD COLUMN IF NOT EXISTS langchain_api_key TEXT,
          ADD COLUMN IF NOT EXISTS auto_reply_enabled BOOLEAN DEFAULT true,
          ADD COLUMN IF NOT EXISTS group_reply_enabled BOOLEAN DEFAULT false,
          ADD COLUMN IF NOT EXISTS session_config JSONB DEFAULT '{}';

        -- Add indexes for LangChain columns
        CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_wapi_langchain_agent_id ON whatsapp_sessions_wapi(langchain_agent_id);
        CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_wapi_auto_reply ON whatsapp_sessions_wapi(auto_reply_enabled);

        RAISE NOTICE 'Updated whatsapp_sessions_wapi table with LangChain integration columns';
    END IF;

    -- Update whatsapp_user if it exists (current code base)
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'whatsapp_user') THEN
        ALTER TABLE whatsapp_user
          ADD COLUMN IF NOT EXISTS langchain_agent_id UUID,
          ADD COLUMN IF NOT EXISTS langchain_api_key TEXT,
          ADD COLUMN IF NOT EXISTS auto_reply_enabled BOOLEAN DEFAULT true,
          ADD COLUMN IF NOT EXISTS group_reply_enabled BOOLEAN DEFAULT false,
          ADD COLUMN IF NOT EXISTS session_config JSONB DEFAULT '{}';

        -- Add indexes for LangChain columns
        CREATE INDEX IF NOT EXISTS idx_whatsapp_user_langchain_agent_id ON whatsapp_user(langchain_agent_id);
        CREATE INDEX IF NOT EXISTS idx_whatsapp_user_auto_reply ON whatsapp_user(auto_reply_enabled);

        RAISE NOTICE 'Updated whatsapp_user table with LangChain integration columns';
    END IF;
END $$;

-- Create whatsapp_messages table for detailed message tracking
CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id SERIAL PRIMARY KEY,
  session_agent_id VARCHAR(255),
  message_id VARCHAR(100) UNIQUE,
  langchain_execution_id UUID,
  from_number VARCHAR(20),
  to_number VARCHAR(20),
  message_type VARCHAR(20) DEFAULT 'text',
  content TEXT,
  media_url TEXT,
  direction VARCHAR(20) DEFAULT 'inbound',
  contact_name VARCHAR(255),
  is_group BOOLEAN DEFAULT false,
  group_name VARCHAR(255),
  metadata JSONB DEFAULT '{}',
  processing_status VARCHAR(20) DEFAULT 'pending',
  processing_error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for whatsapp_messages
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_session_agent_id ON whatsapp_messages(session_agent_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_langchain_execution_id ON whatsapp_messages(langchain_execution_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_from_number ON whatsapp_messages(from_number);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_processing_status ON whatsapp_messages(processing_status);

-- Create langchain_sync_log table for API communication tracking
CREATE TABLE IF NOT EXISTS langchain_sync_log (
  id SERIAL PRIMARY KEY,
  session_agent_id VARCHAR(255),
  message_id INTEGER REFERENCES whatsapp_messages(id),
  sync_type VARCHAR(20),
  langchain_agent_id UUID,
  langchain_execution_id UUID,
  request_data JSONB DEFAULT '{}',
  response_data JSONB DEFAULT '{}',
  status VARCHAR(20) DEFAULT 'pending',
  error_message TEXT,
  http_status INTEGER,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for langchain_sync_log
CREATE INDEX IF NOT EXISTS idx_langchain_sync_session_agent_id ON langchain_sync_log(session_agent_id);
CREATE INDEX IF NOT EXISTS idx_langchain_sync_status ON langchain_sync_log(status);
CREATE INDEX IF NOT EXISTS idx_langchain_sync_created_at ON langchain_sync_log(created_at);

-- Add comments for documentation
COMMENT ON TABLE whatsapp_messages IS 'Stores all WhatsApp messages with LangChain integration tracking';
COMMENT ON TABLE langchain_sync_log IS 'Tracks all API communications between WhatsApp and LangChain services';