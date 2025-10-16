const { pool } = require('./index');

async function findActiveKeyByUserId(userId) {
  // Check if userId is UUID or BIGINT
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId);

  let query;
  if (isUUID) {
    // For UUID users, we need to check against user_id_uuid in whatsapp_user table
    // or have a separate api_key table that supports UUID
    query = `
      SELECT key_hash AS api_key, expires_at, active
      FROM api_key
      WHERE user_id::text = $1
      ORDER BY created_at DESC
      LIMIT 1
    `;
  } else {
    // For BIGINT users (legacy)
    query = `
      SELECT key_hash AS api_key, expires_at, active
      FROM api_key
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 1
    `;
  }

  const { rows } = await pool.query(query, [userId]);

  if (!rows.length) {
    return null;
  }

  const record = rows[0];
  if (record.expires_at && new Date(record.expires_at) < new Date()) {
    return null;
  }
  if (record.active === false) {
    return null;
  }

  return record.api_key;
}

// New function to create/update API key for users (supports both UUID and BIGINT)
async function createOrUpdateApiKey(userId, apiKey, expiresAt = null) {
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId);

  let query;
  if (isUUID) {
    // Store UUID as text in user_id column
    query = `
      INSERT INTO api_key (user_id, key_hash, expires_at, active)
      VALUES ($1, $2, $3, true)
      ON CONFLICT (user_id) DO UPDATE SET
        key_hash = EXCLUDED.key_hash,
        expires_at = EXCLUDED.expires_at,
        active = EXCLUDED.active,
        created_at = NOW()
      RETURNING *
    `;
  } else {
    // Store as BIGINT
    query = `
      INSERT INTO api_key (user_id, key_hash, expires_at, active)
      VALUES ($1, $2, $3, true)
      ON CONFLICT (user_id) DO UPDATE SET
        key_hash = EXCLUDED.key_hash,
        expires_at = EXCLUDED.expires_at,
        active = EXCLUDED.active,
        created_at = NOW()
      RETURNING *
    `;
  }

  const { rows } = await pool.query(query, [userId, apiKey, expiresAt]);
  return rows[0];
}

// Function to get API key without user validation (for LangChain integration)
async function getApiKeyForSession(agentId) {
  const { rows } = await pool.query(
    `SELECT api_key FROM whatsapp_user WHERE agent_id = $1 LIMIT 1`,
    [agentId]
  );

  return rows[0]?.api_key || null;
}

module.exports = {
  findActiveKeyByUserId,
  createOrUpdateApiKey,
  getApiKeyForSession
};