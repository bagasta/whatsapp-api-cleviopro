const messageLogService = require('../services/messageLogService');

function parseLimit(raw) {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

async function getMessageLogs(req, res, next) {
  try {
    const { agentId, direction, limit } = req.query;
    const entries = messageLogService.list({
      agentId: agentId || undefined,
      direction: direction || undefined,
      limit: parseLimit(limit),
    });
    res.json({
      count: entries.length,
      entries,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getMessageLogs,
};
