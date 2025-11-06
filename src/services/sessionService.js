const env = require('../config/env');
const logger = require('../utils/logger');
const sessionManager = require('./whatsappSessionManager');
const { findActiveKeyByUserId, createOrUpdateApiKey } = require('../database/apiKeyRepository');
const { createSessionRecord, findByAgentId, deleteByAgentId, updateStatus } = require('../database/sessionRepository');

const QR_HANDLER_ATTACHED = Symbol('qrHandlerAttached');
const QR_HANDLER_IN_PROGRESS = Symbol('qrHandlerInProgress');

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

function attachQrExpiryCleanup(session, agentId) {
  if (!session || session[QR_HANDLER_ATTACHED]) {
    return;
  }
  session[QR_HANDLER_ATTACHED] = true;
  session.on('qr_expired', async () => {
    if (session.state === 'ready' || session[QR_HANDLER_IN_PROGRESS] || (typeof session.isAwaitingAuthentication === 'function' && !session.isAwaitingAuthentication())) {
      return;
    }
    session[QR_HANDLER_IN_PROGRESS] = true;
    const wasEverReady =
      typeof session.hasReadyHistory === 'function'
        ? session.hasReadyHistory()
        : session.hasEverBeenReady === true;
    const now = new Date();
    const cleanupLabel = wasEverReady
      ? 'QR code expired after prior authentication; preserving session state'
      : 'QR code expired before authentication; cleaning up session';

    logger.info({ agentId }, cleanupLabel);
    try {
      if (wasEverReady) {
        if (typeof session.resetAfterQrExpiry === 'function') {
          await session.resetAfterQrExpiry({ removeAuthFiles: true });
        } else if (typeof session.destroyCurrentClient === 'function') {
          await session.destroyCurrentClient({
            skipLogout: true,
            removeAuthFiles: true,
            allowConnectedDestroy: true,
            reason: 'qr_expired_cleanup',
          });
          session.state = 'disconnected';
        }
        await updateStatus(agentId, { status: 'disconnected', lastDisconnectedAt: now });
      } else {
        await deleteSession(agentId);
        logger.info({ agentId }, 'Session removed after QR expiration');
      }
    } catch (err) {
      logger.error({ err, agentId }, 'Failed to handle expired session cleanup');
    } finally {
      session[QR_HANDLER_IN_PROGRESS] = false;
    }
  });
}

async function createSession({ userId, agentId, apiKey }) {
  const resolvedAgentName = agentId;
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
    sessionName: resolvedAgentName,
    endpointUrlRun: publicEndpointUrl,
    status: 'awaiting_qr',
  });

  logger.info({ agentId, userId, endpointUrl: publicEndpointUrl }, 'Session record persisted');

  const { session } = await sessionManager.createOrUpdateSession({
    userId,
    agentId,
    agentName: resolvedAgentName,
    apiKey,
    aiEndpointUrl,
  });

  attachQrExpiryCleanup(session, agentId);

  const statusRecord = await updateStatus(agentId, deriveStatusPayload(session));
  logger.info({ agentId, state: session.state }, 'Session manager initialized');

  let qrBuffer = session.getQrImage();
  if (!qrBuffer && session.state !== 'ready') {
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

  const liveSession = sessionManager.get(agentId);
  const isAlreadyReady =
    liveSession && typeof liveSession.isReady === 'function'
      ? liveSession.isReady()
      : liveSession && liveSession.state === 'ready';

  if (isAlreadyReady) {
    logger.info({ agentId }, 'Reconnect requested but session is already ready; returning conflict');

    if ((existingRecord.status || '').toLowerCase() !== 'connected') {
      try {
        await updateStatus(agentId, { status: 'connected', lastConnectedAt: new Date() });
      } catch (err) {
        logger.warn({ err, agentId }, 'Failed to persist connected status while skipping reconnect');
      }
    }

    const conflictError = new Error('Session is already connected');
    conflictError.status = 409;
    throw conflictError;
  }

  await updateStatus(agentId, { status: 'reconnecting' });

  const { session, qrBuffer } = await sessionManager.reconnectSession(agentId, { timeoutMs: 30_000 });
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
    },
    status: formatStatus(refreshedRecord),
    qr,
  };
}

async function getSession(agentId) {
  return findByAgentId(agentId);
}

async function ensureLiveSession(agentId, existingRecord = null) {
  const sessionRecord = existingRecord || (await getSession(agentId));
  let session = sessionManager.get(agentId);

  if (session && typeof session.isReady === 'function' && session.isReady()) {
    attachQrExpiryCleanup(session, agentId);
    return { session, sessionRecord };
  }

  if (!session && sessionRecord) {
    const userId = sessionRecord.user_id || sessionRecord.user_id_uuid;
    try {
      const { session: rehydratedSession } = await sessionManager.createOrUpdateSession({
        userId,
        agentId,
        agentName: agentId,
        apiKey: sessionRecord.api_key,
        aiEndpointUrl: buildAiEndpointUrl(agentId),
      });
      session = rehydratedSession;
    } catch (err) {
      const error = new Error('Failed to rehydrate WhatsApp session');
      error.status = 500;
      error.cause = err;
      throw error;
    }
  }

  if (session) {
    attachQrExpiryCleanup(session, agentId);
  }

  return { session, sessionRecord };
}

function mergeStatusWithLiveState({ sessionState, storedStatus }) {
  const normalized = storedStatus
    ? { ...storedStatus }
    : {
        state: sessionState === 'ready' ? 'connected' : sessionState || 'unknown',
        lastConnectedAt: null,
        lastDisconnectedAt: null,
        updatedAt: null,
      };

  if (sessionState === 'ready') {
    normalized.state = 'connected';
  } else if (sessionState === 'initializing' || sessionState === 'qr') {
    normalized.state = normalized.state || 'awaiting_qr';
  } else if (sessionState === 'disconnected') {
    normalized.state = 'disconnected';
  } else if (sessionState === 'destroyed') {
    normalized.state = 'terminated';
  }

  return normalized;
}

async function getSessionStatus(agentId) {
  let sessionRecord = null;
  let session = null;

  try {
    ({ session, sessionRecord } = await ensureLiveSession(agentId));
  } catch (err) {
    logger.warn({ err, agentId }, 'Failed to ensure live session while reading status; returning persisted state');
    session = sessionManager.get(agentId) || null;
    sessionRecord = sessionRecord || (await getSession(agentId));
  }

  if (!session && !sessionRecord) {
    return null;
  }

  const storedStatus = sessionRecord ? formatStatus(sessionRecord) : null;
  const sessionState = session?.state || null;
  const status = mergeStatusWithLiveState({ sessionState, storedStatus });

  return {
    agentId,
    userId: sessionRecord?.user_id || sessionRecord?.user_id_uuid || null,
    status,
    sessionState,
    isReady: sessionState === 'ready',
    hasClient: Boolean(session),
  };
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
  ensureLiveSession,
  getSessionStatus,
};
