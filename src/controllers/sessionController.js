const sessionService = require('../services/sessionService');

function validateCreateSession(body) {
  const errors = [];
  if (!body || typeof body !== 'object') {
    errors.push('Request body must be a JSON object');
    return errors;
  }
  if (!body.userId) errors.push('userId is required');
  if (!body.agentId) errors.push('agentId is required');
  return errors;
}

async function createSession(req, res, next) {
  try {
    const errors = validateCreateSession(req.body);
    if (errors.length) {
      const err = new Error('Validation failed');
      err.status = 400;
      err.details = errors;
      throw err;
    }

    const { userId, agentId, Apikey } = req.body;
    const result = await sessionService.createSession({ userId, agentId, apiKey: Apikey });

    if (result.qr) {
      req.loggerInfo = { ...(req.loggerInfo || {}), qrProvided: true };
      res.status(201).json({
        message: 'Session created. Scan the QR code within 5 minutes to authenticate.',
        endpointUrl: result.endpointUrl,
        session: {
          userId,
          agentId,
        },
        status: result.status,
        qr: result.qr,
      });
      return;
    }

    req.loggerInfo = { ...(req.loggerInfo || {}), qrProvided: false };
    res.status(200).json({
      message: 'Session already authenticated',
      endpointUrl: result.endpointUrl,
      session: {
        userId,
        agentId,
      },
      status: result.status,
    });
  } catch (err) {
    next(err);
  }
}

async function deleteSession(req, res, next) {
  try {
    const { agentId } = req.params;
    if (!agentId) {
      const error = new Error('agentId is required');
      error.status = 400;
      throw error;
    }
    await sessionService.deleteSession(agentId);
    req.loggerInfo = { ...(req.loggerInfo || {}), action: 'delete_session' };
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

async function reconnectSession(req, res, next) {
  try {
    const { agentId } = req.params;
    if (!agentId) {
      const error = new Error('agentId is required');
      error.status = 400;
      throw error;
    }
    const result = await sessionService.reconnectSession(agentId);
    req.loggerInfo = { ...(req.loggerInfo || {}), qrProvided: Boolean(result.qr) };
    res.json(result);
  } catch (err) {
    next(err);
  }
}

async function getSessionStatus(req, res, next) {
  try {
    const { agentId } = req.params;
    if (!agentId) {
      const error = new Error('agentId is required');
      error.status = 400;
      throw error;
    }

    const details = await sessionService.getSessionStatus(agentId);
    if (!details) {
      const error = new Error('Session not found');
      error.status = 404;
      throw error;
    }

    const state =
      details?.status?.state ||
      (details?.sessionState === 'ready'
        ? 'connected'
        : details?.sessionState || (details?.isReady ? 'connected' : 'unknown'));

    const responsePayload = {
      ...details,
      state,
      isConnected: state === 'connected',
    };

    req.loggerInfo = { ...(req.loggerInfo || {}), action: 'get_session_status' };
    res.json(responsePayload);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createSession,
  deleteSession,
  reconnectSession,
  getSessionStatus,
};
