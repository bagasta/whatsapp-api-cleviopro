const sessionService = require('../services/sessionService');
const sessionManager = require('../services/whatsappSessionManager');
const { forwardToAI } = require('../services/aiForwarder');
const env = require('../config/env');
const { extractReplyText } = require('../utils/aiResponseParser');
const { showTypingWhile } = require('../utils/typingIndicator');

function extractBearerToken(header) {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!/^Bearer$/i.test(scheme)) return null;
  return token;
}

function validatePayload(body) {
  const errors = [];
  if (!body.message) errors.push('message is required');
  if (!body.sessionId) errors.push('sessionId is required');
  return errors;
}

async function sendMessage(req, res, next) {
  try {
    const { agentId } = req.params;
    const payloadErrors = validatePayload(req.body || {});
    if (payloadErrors.length) {
      const err = new Error('Validation failed');
      err.status = 400;
      err.details = payloadErrors;
      throw err;
    }

    const sessionRecord = await sessionService.getSession(agentId);
    if (!sessionRecord) {
      const err = new Error('Session not found');
      err.status = 404;
      throw err;
    }

    const token = extractBearerToken(req.headers.authorization || '');
    if (sessionRecord.api_key && token !== sessionRecord.api_key) {
      const err = new Error('Unauthorized');
      err.status = 401;
      throw err;
    }

    const openAiKey = req.body.openai_api_key || env.defaultOpenAiApiKey;
    const session = sessionManager.get(agentId);
    if (!session) {
      const err = new Error('WhatsApp session is not running');
      err.status = 404;
      throw err;
    }

    if (session.state !== 'ready') {
      const err = new Error('WhatsApp session is not ready to send messages');
      err.status = 409;
      throw err;
    }

    const endpointUrl = session.aiEndpointUrl || (env.aiBackendBaseUrl ? `${env.aiBackendBaseUrl.replace(/\/$/, '')}/agents/${agentId}/run` : null);

    if (!endpointUrl) {
      const err = new Error('AI backend URL not configured');
      err.status = 503;
      throw err;
    }

    let chat = null;
    try {
      chat = await session.client.getChatById(req.body.sessionId);
    } catch (err) {
      // We can still forward without typing indicator if chat lookup fails
      chat = null;
    }

    const forwarded = await showTypingWhile(
      forwardToAI({
        endpointUrl,
        apiKey: sessionRecord.api_key,
        message: req.body.message,
        sessionId: req.body.sessionId,
        openAiKey,
        memoryEnable: req.body.memory_enable,
        contextMemory: req.body.context_memory,
        ragEnable: req.body.rag_enable,
        metadata: req.body.metadata,
      }),
      chat
    );

    const replyText = extractReplyText(forwarded);
    let replySent = false;
    if (replyText) {
      try {
        await session.client.sendMessage(req.body.sessionId, replyText);
        replySent = true;
      } catch (err) {
        const logErr = new Error('Failed to send AI reply to WhatsApp');
        logErr.details = err.message;
        logErr.status = 502;
        logErr.cause = err;
        throw logErr;
      }
    }

    const responsePayload = { status: 'forwarded', payload: forwarded, replySent, replyText: replyText || null };
    req.loggerInfo = {
      ...(req.loggerInfo || {}),
      agentId,
      sessionId: req.body.sessionId,
      replySent,
      replyTextExists: Boolean(replyText),
    };
    res.json(responsePayload);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  sendMessage,
};
