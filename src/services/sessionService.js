const env = require('../config/env');
const logger = require('../utils/logger');
const sessionManager = require('./whatsappSessionManager');
const { findActiveKeyByUserId, createOrUpdateApiKey } = require('../database/apiKeyRepository');
const { createSessionRecord, findByAgentId, deleteByAgentId, updateStatus } = require('../database/sessionRepository');

function trimTrailingSlash(url) {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function buildEndpointUrl(agentId, baseUrl) {
  const base = trimTrailingSlash(baseUrl || env.appBaseUrl);
  return `${base}/api/v1/agents/${agentId}/execute`;
}

function buildAiEndpointUrl(agentId) {
  if (!env.aiBackendBaseUrl) {
    return null;
  }
  return buildEndpointUrl(agentId, env.aiBackendBaseUrl);
}

function buildPublicEndpointUrl(agentId) {
  const base = env.appBaseUrl.endsWith('/') ? env.appBaseUrl.slice(0, -1) : env.appBaseUrl;
  return `${base}/api/v1/agents/${agentId}/execute`;
}

async function createSession({ userId, agentId, agentName, apiKey }) {
  // If no API key provided, try to find existing one
  if (!apiKey) {
    apiKey = await findActiveKeyByUserId(userId);
  }

  // If no API key found, create a default one for LangChain integration
  if (!apiKey) {
    logger.warn({ userId, agentId }, 'No API key found for user, creating default key');
    const defaultApiKey = `sk-default-${agentId}-${Date.now()}`;
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // 1 year

    await createOrUpdateApiKey(userId, defaultApiKey, expiresAt);
    apiKey = defaultApiKey;
  } else {
    // Store the provided API key
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // 1 year
    await createOrUpdateApiKey(userId, apiKey, expiresAt);
    logger.info({ userId, agentId }, 'Using provided API key');
  }

  const publicEndpointUrl = buildPublicEndpointUrl(agentId);
  const aiEndpointUrl = buildAiEndpointUrl(agentId);

  const record = await createSessionRecord({
    userId,
    agentId,
    apiKey,
    sessionName: agentName,
    endpointUrlRun: publicEndpointUrl,
    status: 'awaiting_qr',
  });

  logger.info({ agentId, userId, endpointUrl: publicEndpointUrl }, 'Session record persisted');

  const { session } = await sessionManager.createOrUpdateSession({
    userId,
    agentId,
    agentName,
    apiKey,
    aiEndpointUrl,
  });

  const statusRecord = await updateStatus(agentId, deriveStatusPayload(session));
  logger.info({ agentId, state: session.state }, 'Session manager initialized');

  let qrBuffer = session.getQrImage();
  if (!qrBuffer) {
    try {
      qrBuffer = await session.waitForQr();
    } catch (err) {
      logger.warn({ err, agentId }, 'Could not obtain QR code');
      if (session.state !== 'ready') {
        throw err;
      }
    }
  }

  const qr = qrBuffer
    ? {
        contentType: 'image/png',
        base64: qrBuffer.toString('base64'),
        expiresAt: session.currentQr ? new Date(session.currentQr.expiresAt).toISOString() : null,
      }
    : null;

  return {
    sessionRecord: record,
    qr,
    endpointUrl: publicEndpointUrl,
    status: formatStatus(statusRecord),
  };
}

async function deleteSession(agentId) {
  await sessionManager.deleteSession(agentId);
  await deleteByAgentId(agentId);
  logger.info({ agentId }, 'Session deleted');
}

async function reconnectSession(agentId) {
  const existingRecord = await findByAgentId(agentId);
  if (!existingRecord) {
    const error = new Error('Session not found');
    error.status = 404;
    throw error;
  }

  await updateStatus(agentId, { status: 'reconnecting' });

  const { session, qrBuffer } = await sessionManager.reconnectSession(agentId, { forceQr: true });
  logger.info({ agentId }, 'Session reconnect triggered');

  const refreshedRecord = await findByAgentId(agentId);
  const qr = qrBuffer
    ? {
        contentType: 'image/png',
        base64: qrBuffer.toString('base64'),
        expiresAt: session.currentQr ? new Date(session.currentQr.expiresAt).toISOString() : null,
      }
    : null;

  return {
    message: qr
      ? 'Session reinitialized. Scan the QR code within 5 minutes to authenticate.'
      : 'Session reinitialized.',
    endpointUrl: refreshedRecord.endpoint_url_run,
    session: {
      userId: refreshedRecord.user_id,
      agentId: refreshedRecord.agent_id,
      agentName: refreshedRecord.session_name,
    },
    status: formatStatus(refreshedRecord),
    qr,
  };
}

async function getSession(agentId) {
  return findByAgentId(agentId);
}

function deriveStatusPayload(session) {
  const state = session?.state;
  const now = new Date();

  switch (state) {
    case 'ready':
      return { status: 'connected', lastConnectedAt: now };
    case 'disconnected':
      return { status: 'disconnected', lastDisconnectedAt: now };
    case 'destroyed':
      return { status: 'terminated', lastDisconnectedAt: now };
    default:
      return { status: 'awaiting_qr' };
  }
}

function formatStatus(record) {
  if (!record) {
    return null;
  }
  const toIso = (value) => (value instanceof Date ? value.toISOString() : value ? new Date(value).toISOString() : null);
  return {
    state: record.status,
    lastConnectedAt: toIso(record.last_connected_at),
    lastDisconnectedAt: toIso(record.last_disconnected_at),
    updatedAt: toIso(record.updated_at),
  };
}

module.exports = {
  createSession,
  deleteSession,
  reconnectSession,
  getSession,
  buildAiEndpointUrl,
};
