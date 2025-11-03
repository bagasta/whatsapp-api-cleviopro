const logger = require('../utils/logger');
const sessionService = require('./sessionService');
const { findActiveSessions } = require('../database/sessionRepository');

async function bootstrapSessions() {
  const sessions = await findActiveSessions();
  if (!sessions.length) {
    logger.info('No persisted WhatsApp sessions to bootstrap');
    return;
  }

  logger.info({ count: sessions.length }, 'Bootstrapping persisted WhatsApp sessions');

  for (const record of sessions) {
    try {
      const { agent_id: agentId } = record;
      await sessionService.ensureLiveSession(agentId, record);
      logger.info({ agentId }, 'Restored WhatsApp session from persisted data');
    } catch (err) {
      logger.error({ err, agentId: record.agent_id }, 'Failed to bootstrap WhatsApp session');
    }
  }
}

module.exports = {
  bootstrapSessions,
};
