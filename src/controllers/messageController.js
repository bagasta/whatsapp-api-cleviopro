const sessionService = require('../services/sessionService');
const sessionManager = require('../services/whatsappSessionManager');
const { forwardToAI } = require('../services/aiForwarder');
const env = require('../config/env');
const { extractReplyText } = require('../utils/aiResponseParser');
const { showTypingWhile } = require('../utils/typingIndicator');
const mediaSender = require('../services/mediaSender');

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

function validateDirectMessagePayload(body) {
  const errors = [];
  if (!body.message) errors.push('message is required');
  if (!body.to) errors.push('to is required');
  return errors;
}

function validateMediaMessagePayload(body) {
  const errors = [];
  if (!body || typeof body !== 'object') {
    return ['Request body must be a JSON object'];
  }
  if (!body.to) errors.push('to is required');
  if (!body.type) errors.push('type is required');
  if (!body.data && !body.url) errors.push('data or url is required');
  if (body.type && !['document', 'image', 'audio', 'video', 'sticker'].includes(body.type)) {
    errors.push('type must be one of document, image, audio, video, sticker');
  }
  return errors;
}

function normalizeRecipient(to) {
  if (typeof to !== 'string') {
    return null;
  }
  const trimmed = to.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.includes('@')) {
    return trimmed;
  }
  const digits = trimmed.replace(/\D+/g, '');
  if (!digits) {
    return null;
  }
  return `${digits}@c.us`;
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

async function sendDirectMessage(req, res, next) {
  try {
    const { agentId } = req.params;
    const payloadErrors = validateDirectMessagePayload(req.body || {});
    if (payloadErrors.length) {
      const err = new Error('Validation failed');
      err.status = 400;
      err.details = payloadErrors;
      throw err;
    }

    const { session, sessionRecord } = await sessionService.ensureLiveSession(agentId);

    if (!session && !sessionRecord) {
      const err = new Error('Session not found');
      err.status = 404;
      throw err;
    }

    const expectedApiKey = sessionRecord?.api_key || session?.apiKey;
    const token = extractBearerToken(req.headers.authorization || '');
    if (expectedApiKey && token !== expectedApiKey) {
      const err = new Error('Unauthorized');
      err.status = 401;
      throw err;
    }

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

    const chatId = normalizeRecipient(req.body.to);
    if (!chatId) {
      const err = new Error('Invalid recipient');
      err.status = 400;
      err.details = ['to must be a phone number or WhatsApp ID'];
      throw err;
    }

    await session.client.sendMessage(chatId, req.body.message);
    req.loggerInfo = {
      ...(req.loggerInfo || {}),
      agentId,
      to: chatId,
      outbound: true,
    };
    res.status(200).json({ status: 'sent', to: chatId });
  } catch (err) {
    next(err);
  }
}

async function sendMediaMessage(req, res, next) {
  try {
    const { agentId } = req.params;
    const errors = validateMediaMessagePayload(req.body);
    if (errors.length) {
      const err = new Error('Validation failed');
      err.status = 400;
      err.details = errors;
      throw err;
    }

    const { session, sessionRecord } = await sessionService.ensureLiveSession(agentId);
    if (!session && !sessionRecord) {
      const err = new Error('Session not found');
      err.status = 404;
      throw err;
    }

    const expectedApiKey = sessionRecord?.api_key || session?.apiKey;
    const token = extractBearerToken(req.headers.authorization || '');
    if (expectedApiKey && token !== expectedApiKey) {
      const err = new Error('Unauthorized');
      err.status = 401;
      throw err;
    }

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

    const chatId = normalizeRecipient(req.body.to);
    if (!chatId) {
      const err = new Error('Invalid recipient');
      err.status = 400;
      err.details = ['to must be a phone number or WhatsApp ID'];
      throw err;
    }

    const sendResult = await mediaSender.sendMedia({
      session,
      chatId,
      type: req.body.type,
      data: req.body.data,
      url: req.body.url,
      filename: req.body.filename,
      caption: req.body.caption,
      mimetype: req.body.mimetype,
      saveToTemp: req.body.save_to_temp !== false,
      metadata: req.body.metadata,
    });

    req.loggerInfo = {
      ...(req.loggerInfo || {}),
      agentId,
      to: chatId,
      outbound: true,
      mediaType: req.body.type,
    };

    res.status(200).json({
      status: 'sent',
      to: chatId,
      type: req.body.type,
      messageId: sendResult?.id?._serialized || null,
      previewPath: sendResult?.previewPath || null,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  sendMessage,
  sendDirectMessage,
  sendMediaMessage,
};
