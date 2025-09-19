const { pool } = require('./index');

async function findActiveKeyByUserId(userId) {
  const { rows } = await pool.query(
    `SELECT key_hash AS api_key, expires_at, active FROM api_key WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
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

module.exports = { findActiveKeyByUserId };
