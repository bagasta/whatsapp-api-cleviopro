const { pool } = require('./index');

async function findByAgentId(agentId) {
  const { rows } = await pool.query(
    `SELECT * FROM whatsapp_user WHERE agent_id = $1 LIMIT 1`,
    [agentId]
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
}) {
  const { rows } = await pool.query(
    `INSERT INTO whatsapp_user (user_id, agent_id, api_key, session_name, endpoint_url_run, status, last_connected_at, last_disconnected_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (agent_id) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       api_key = EXCLUDED.api_key,
       session_name = EXCLUDED.session_name,
       endpoint_url_run = EXCLUDED.endpoint_url_run,
       status = EXCLUDED.status,
       last_connected_at = COALESCE(EXCLUDED.last_connected_at, whatsapp_user.last_connected_at),
       last_disconnected_at = COALESCE(EXCLUDED.last_disconnected_at, whatsapp_user.last_disconnected_at),
       updated_at = NOW()
     RETURNING *`,
    [userId, agentId, apiKey, sessionName, endpointUrlRun, status || 'awaiting_qr', lastConnectedAt || null, lastDisconnectedAt || null]
  );
  return rows[0];
}

async function deleteByAgentId(agentId) {
  await pool.query(`DELETE FROM whatsapp_user WHERE agent_id = $1`, [agentId]);
}

async function updateStatus(agentId, { status, lastConnectedAt, lastDisconnectedAt } = {}) {
  const { rows } = await pool.query(
    `UPDATE whatsapp_user
     SET
       status = COALESCE($2, status),
       last_connected_at = COALESCE($3, last_connected_at),
       last_disconnected_at = COALESCE($4, last_disconnected_at),
       updated_at = NOW()
     WHERE agent_id = $1
     RETURNING *`,
    [agentId, status || null, lastConnectedAt || null, lastDisconnectedAt || null]
  );
  return rows[0] || null;
}

module.exports = {
  findByAgentId,
  findActiveSessions,
  createSessionRecord,
  deleteByAgentId,
  updateStatus,
};
