const { pool } = require('./index');

function normalizeAgentId(agentId) {
  return typeof agentId === 'string' ? agentId.trim() : agentId;
}

async function findByAgentId(agentId) {
  const normalizedId = normalizeAgentId(agentId);
  const { rows } = await pool.query(
    `SELECT * FROM whatsapp_user WHERE LOWER(agent_id) = LOWER($1) LIMIT 1`,
    [normalizedId]
  );
  return rows[0] || null;
}

async function findActiveSessions() {
  const { rows } = await pool.query(
    `SELECT * FROM whatsapp_user`
  );
  return rows;
}

async function createSessionRecord({
  userId,
  agentId,
  apiKey,
  sessionName,
  endpointUrlRun,
  status,
  lastConnectedAt,
  lastDisconnectedAt,
  langchainAgentId,
  langchainApiKey,
  sessionConfig = {},
}) {
  // Check if userId is UUID or BIGINT
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId);

  let query;
  let params;

  if (isUUID) {
    // For UUID users, store in user_id_uuid and keep user_id as NULL
    query = `
      INSERT INTO whatsapp_user (
        user_id, user_id_uuid, agent_id, api_key, session_name,
        endpoint_url_run, status, last_connected_at, last_disconnected_at,
        langchain_agent_id, langchain_api_key, session_config
      )
      VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (agent_id) DO UPDATE SET
        user_id_uuid = EXCLUDED.user_id_uuid,
        api_key = EXCLUDED.api_key,
        session_name = EXCLUDED.session_name,
        endpoint_url_run = EXCLUDED.endpoint_url_run,
        status = EXCLUDED.status,
        last_connected_at = COALESCE(EXCLUDED.last_connected_at, whatsapp_user.last_connected_at),
        last_disconnected_at = COALESCE(EXCLUDED.last_disconnected_at, whatsapp_user.last_disconnected_at),
        langchain_agent_id = COALESCE(EXCLUDED.langchain_agent_id, whatsapp_user.langchain_agent_id),
        langchain_api_key = COALESCE(EXCLUDED.langchain_api_key, whatsapp_user.langchain_api_key),
        session_config = COALESCE(EXCLUDED.session_config, whatsapp_user.session_config),
        updated_at = NOW()
      RETURNING *
    `;
    params = [
      userId,        // user_id_uuid
      agentId,
      apiKey,
      sessionName,
      endpointUrlRun,
      status || 'awaiting_qr',
      lastConnectedAt || null,
      lastDisconnectedAt || null,
      langchainAgentId || null,
      langchainApiKey || null,
      sessionConfig
    ];
  } else {
    // For BIGINT users (legacy)
    query = `
      INSERT INTO whatsapp_user (
        user_id, agent_id, api_key, session_name,
        endpoint_url_run, status, last_connected_at, last_disconnected_at,
        langchain_agent_id, langchain_api_key, session_config
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (agent_id) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        api_key = EXCLUDED.api_key,
        session_name = EXCLUDED.session_name,
        endpoint_url_run = EXCLUDED.endpoint_url_run,
        status = EXCLUDED.status,
        last_connected_at = COALESCE(EXCLUDED.last_connected_at, whatsapp_user.last_connected_at),
        last_disconnected_at = COALESCE(EXCLUDED.last_disconnected_at, whatsapp_user.last_disconnected_at),
        langchain_agent_id = COALESCE(EXCLUDED.langchain_agent_id, whatsapp_user.langchain_agent_id),
        langchain_api_key = COALESCE(EXCLUDED.langchain_api_key, whatsapp_user.langchain_api_key),
        session_config = COALESCE(EXCLUDED.session_config, whatsapp_user.session_config),
        updated_at = NOW()
      RETURNING *
    `;
    params = [
      userId,
      agentId,
      apiKey,
      sessionName,
      endpointUrlRun,
      status || 'awaiting_qr',
      lastConnectedAt || null,
      lastDisconnectedAt || null,
      langchainAgentId || null,
      langchainApiKey || null,
      sessionConfig
    ];
  }

  const { rows } = await pool.query(query, params);
  return rows[0];
}

async function deleteByAgentId(agentId) {
  const normalizedId = normalizeAgentId(agentId);
  await pool.query(`DELETE FROM whatsapp_user WHERE LOWER(agent_id) = LOWER($1)`, [normalizedId]);
}

async function updateStatus(agentId, { status, lastConnectedAt, lastDisconnectedAt } = {}) {
  const normalizedId = normalizeAgentId(agentId);
  const { rows } = await pool.query(
    `UPDATE whatsapp_user
     SET
       status = COALESCE($2, status),
       last_connected_at = COALESCE($3, last_connected_at),
       last_disconnected_at = COALESCE($4, last_disconnected_at),
       updated_at = NOW()
     WHERE LOWER(agent_id) = LOWER($1)
     RETURNING *`,
    [normalizedId, status || null, lastConnectedAt || null, lastDisconnectedAt || null]
  );
  return rows[0] || null;
}

// New functions for LangChain integration
async function updateLangChainIntegration(agentId, { langchainAgentId, langchainApiKey, sessionConfig }) {
  const { rows } = await pool.query(
    `UPDATE whatsapp_user
     SET
       langchain_agent_id = COALESCE($2, langchain_agent_id),
       langchain_api_key = COALESCE($3, langchain_api_key),
       session_config = COALESCE($4, session_config),
       updated_at = NOW()
     WHERE agent_id = $1
     RETURNING *`,
    [agentId, langchainAgentId || null, langchainApiKey || null, sessionConfig || {}]
  );
  return rows[0] || null;
}

async function findByLangChainAgentId(langchainAgentId) {
  const { rows } = await pool.query(
    `SELECT * FROM whatsapp_user WHERE langchain_agent_id = $1 LIMIT 1`,
    [langchainAgentId]
  );
  return rows[0] || null;
}

async function findByUserIdUuid(userIdUuid) {
  const { rows } = await pool.query(
    `SELECT * FROM whatsapp_user WHERE user_id_uuid = $1 LIMIT 1`,
    [userIdUuid]
  );
  return rows[0] || null;
}

module.exports = {
  findByAgentId,
  findActiveSessions,
  createSessionRecord,
  deleteByAgentId,
  updateStatus,
  updateLangChainIntegration,
  findByLangChainAgentId,
  findByUserIdUuid,
};
