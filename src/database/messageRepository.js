const { pool } = require('./index');

async function createMessageRecord({
  sessionAgentId,
  messageId,
  langchainExecutionId,
  fromNumber,
  toNumber,
  messageType = 'text',
  content,
  mediaUrl,
  direction = 'inbound',
  contactName,
  isGroup = false,
  groupName,
  metadata = {},
}) {
  const { rows } = await pool.query(
    `INSERT INTO whatsapp_messages (
       session_agent_id, message_id, langchain_execution_id, from_number,
       to_number, message_type, content, media_url, direction,
       contact_name, is_group, group_name, metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [
      sessionAgentId,
      messageId,
      langchainExecutionId || null,
      fromNumber,
      toNumber,
      messageType,
      content,
      mediaUrl || null,
      direction,
      contactName || null,
      isGroup,
      groupName || null,
      metadata
    ]
  );
  return rows[0];
}

async function updateMessageProcessingStatus(messageId, { processingStatus, langchainExecutionId, processingError }) {
  const { rows } = await pool.query(
    `UPDATE whatsapp_messages
     SET
       processing_status = COALESCE($2, processing_status),
       langchain_execution_id = COALESCE($3, langchain_execution_id),
       processing_error = COALESCE($4, processing_error)
     WHERE id = $1
     RETURNING *`,
    [messageId, processingStatus || null, langchainExecutionId || null, processingError || null]
  );
  return rows[0] || null;
}

async function findByMessageId(messageId) {
  const { rows } = await pool.query(
    `SELECT * FROM whatsapp_messages WHERE message_id = $1 LIMIT 1`,
    [messageId]
  );
  return rows[0] || null;
}

async function findByLangChainExecutionId(langchainExecutionId) {
  const { rows } = await pool.query(
    `SELECT * FROM whatsapp_messages WHERE langchain_execution_id = $1`,
    [langchainExecutionId]
  );
  return rows;
}

async function getMessagesBySession(sessionAgentId, { limit = 50, offset = 0 } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM whatsapp_messages
     WHERE session_agent_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [sessionAgentId, limit, offset]
  );
  return rows;
}

async function getPendingMessages() {
  const { rows } = await pool.query(
    `SELECT * FROM whatsapp_messages
     WHERE processing_status = 'pending'
     ORDER BY created_at ASC`
  );
  return rows;
}

module.exports = {
  createMessageRecord,
  updateMessageProcessingStatus,
  findByMessageId,
  findByLangChainExecutionId,
  getMessagesBySession,
  getPendingMessages,
};