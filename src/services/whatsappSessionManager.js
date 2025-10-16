const path = require('path');
const { EventEmitter } = require('events');
const fs = require('fs-extra');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const config = require('../config/env');
const logger = require('../utils/logger');
const tempFileManager = require('./tempFileManager');
const { forwardToAI } = require('./aiForwarder');
const { updateStatus } = require('../database/sessionRepository');
const { extractReplyText } = require('../utils/aiResponseParser');
const { showTypingWhile } = require('../utils/typingIndicator');

class WhatsappSession extends EventEmitter {
  constructor({ userId, agentId, agentName, apiKey, aiEndpointUrl }) {
    super();
    this.userId = userId;
    this.agentId = agentId;
    this.agentName = agentName;
    this.apiKey = apiKey;
    this.aiEndpointUrl = aiEndpointUrl;
    this.state = 'initializing';
    this.currentQr = null;
    this.client = this.buildClient();
    this.registerEvents();
  }

  buildClient() {
    return new Client({
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-extensions'],
      },
      authStrategy: new LocalAuth({
        clientId: `agent-${this.agentId}`,
        dataPath: path.join(process.cwd(), '.wwebjs_auth'),
      }),
    });
  }

  registerEvents() {
    this.client.on('qr', async (qr) => {
      try {
        const buffer = await qrcode.toBuffer(qr, { type: 'png', width: 300 });
        const expiresAt = Date.now() + config.qrExpirationMinutes * 60 * 1000;
        this.currentQr = { buffer, generatedAt: Date.now(), expiresAt };
        this.emit('qr', this.currentQr);
        logger.info({ agentId: this.agentId }, 'QR code generated');
        updateStatus(this.agentId, { status: 'awaiting_qr' }).catch((err) =>
          logger.warn({ err, agentId: this.agentId }, 'Failed to persist QR awaiting status')
        );
        setTimeout(() => {
          if (this.currentQr && this.currentQr.expiresAt <= Date.now()) {
            this.currentQr = null;
            this.emit('qr_expired');
          }
        }, config.qrExpirationMinutes * 60 * 1000).unref();
      } catch (err) {
        logger.error({ err }, 'Failed to generate QR code image');
      }
    });

    this.client.on('ready', () => {
      this.state = 'ready';
      this.me = this.client.info?.wid?._serialized;
      logger.info({ agentId: this.agentId }, 'WhatsApp session ready');
      this.emit('ready');
      updateStatus(this.agentId, { status: 'connected', lastConnectedAt: new Date() }).catch((err) =>
        logger.warn({ err, agentId: this.agentId }, 'Failed to persist connected status')
      );
    });

    this.client.on('authenticated', () => {
      logger.info({ agentId: this.agentId }, 'WhatsApp session authenticated');
    });

    this.client.on('auth_failure', (msg) => {
      logger.error({ agentId: this.agentId, msg }, 'Authentication failure');
      this.emit('auth_failure', msg);
      updateStatus(this.agentId, { status: 'auth_failed', lastDisconnectedAt: new Date() }).catch((err) =>
        logger.warn({ err, agentId: this.agentId }, 'Failed to persist auth failure status')
      );
    });

    this.client.on('disconnected', (reason) => {
      this.state = 'disconnected';
      logger.warn({ agentId: this.agentId, reason }, 'WhatsApp session disconnected');
      this.emit('disconnected', reason);
      updateStatus(this.agentId, { status: 'disconnected', lastDisconnectedAt: new Date() }).catch((err) =>
        logger.warn({ err, agentId: this.agentId }, 'Failed to persist disconnected status')
      );
    });

    this.client.on('message', (message) => {
      this.handleIncomingMessage(message).catch((err) => {
        logger.error({ err, agentId: this.agentId }, 'Failed to handle incoming message');
      });
    });
  }

  async initialize() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    await tempFileManager.init();
    await this.client.initialize();
  }

  getQrImage() {
    if (this.currentQr && this.currentQr.expiresAt > Date.now()) {
      return this.currentQr.buffer;
    }
    return null;
  }

  waitForQr(timeoutMs = 60_000) {
    const existing = this.getQrImage();
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const onQr = (qr) => {
        cleanup();
        resolve(qr.buffer);
      };
      const onExpired = () => {
        cleanup();
        reject(new Error('QR code expired before retrieval'));
      };
      const onReady = () => {
        cleanup();
        reject(new Error('Session already authenticated'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for QR code'));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        this.off('qr', onQr);
        this.off('qr_expired', onExpired);
        this.off('ready', onReady);
      };

      this.on('qr', onQr);
      this.on('qr_expired', onExpired);
      this.on('ready', onReady);
    });
  }

  async refreshQr(timeoutMs = 60_000) {
    this.currentQr = null;
    const waitQrPromise = this.waitForQr(timeoutMs);
    try {
      await this.client.logout();
      this.state = 'initializing';
    } catch (err) {
      logger.debug({ err, agentId: this.agentId }, 'Logout during QR refresh failed, continuing');
    }
    await this.client.initialize();
    const buffer = await waitQrPromise;
    return buffer;
  }

  async handleIncomingMessage(message) {
    logger.info({
      agentId: this.agentId,
      messageId: message.id?._serialized,
      from: message.from,
      fromMe: message.fromMe,
      type: message.type,
      hasBody: !!message.body,
      body: message.body?.substring(0, 50)
    }, 'handleIncomingMessage called');

    if (!message || message.fromMe) {
      logger.debug({ agentId: this.agentId, fromMe: message.fromMe }, 'Ignoring message from self or null message');
      return;
    }

    if (message.isStatus || (typeof message.from === 'string' && message.from.includes('@status'))) {
      logger.debug({ agentId: this.agentId }, 'Ignoring status message');
      return;
    }

    const chat = await message.getChat();
    const contact = await message.getContact();

    const metadata = {
      whatsapp_name: contact?.pushname || contact?.name || contact?.number || 'Unknown',
      whatsapp_number: contact?.number,
      chat_name: chat?.name,
      is_group: chat?.isGroup === true,
    };

    if (chat.isGroup) {
      const botId = this.client.info?.wid?._serialized;
      if (!botId) {
        logger.debug({ agentId: this.agentId }, 'Bot id unknown yet, skip group message');
        return;
      }
      const mentionedIds = new Set((message.mentionedIds || []).map((id) => id._serialized || id));
      if (botId) {
        const explicitMention = mentionedIds.has(botId);
        if (!explicitMention) {
          const mentions = await message.getMentions();
          if (Array.isArray(mentions)) {
            mentions.forEach((mention) => mentionedIds.add(mention.id._serialized));
          }
        }
      }
      if (!mentionedIds.size || (botId && !mentionedIds.has(botId))) {
        logger.debug({ agentId: this.agentId }, 'Ignoring group message without mention');
        return;
      }
    }

    if (message.hasMedia) {
      try {
        const media = await message.downloadMedia();
        await tempFileManager.saveMedia(media, { sessionId: chat.id?._serialized, from: contact?.number });
      } catch (err) {
        logger.warn({ err }, 'Failed to store media attachment');
      }
    }

    if (message.type !== 'chat') {
      logger.debug({ agentId: this.agentId, type: message.type }, 'Ignoring non-text message for AI forwarding');
      return;
    }

    const trimmed = (message.body || '').trim();
    if (!trimmed) {
      return;
    }

    const sessionId = chat.id?._serialized || contact.id?._serialized;

    logger.info({
      agentId: this.agentId,
      sessionId,
      message: trimmed,
      hasAiEndpoint: !!this.aiEndpointUrl,
      hasApiKey: !!this.apiKey,
      aiEndpointUrl: this.aiEndpointUrl
    }, 'Preparing to forward message to AI');

    const aiResponse = await showTypingWhile(
      forwardToAI({
        endpointUrl: this.aiEndpointUrl,
        apiKey: this.apiKey,
        message: trimmed,
        sessionId,
        openAiKey: this.apiKey, // Use the same API key for OpenAI
        metadata,
      }),
      chat
    );

    logger.info({
      agentId: this.agentId,
      sessionId,
      aiResponseReceived: !!aiResponse
    }, 'AI forwarding completed');

    const replyText = extractReplyText(aiResponse);
    if (replyText) {
      try {
        await message.reply(replyText);
      } catch (err) {
        logger.error({ err, agentId: this.agentId }, 'Failed to send AI reply back to chat');
      }
    }
  }

  async destroy() {
    try {
      await this.client.destroy();
    } catch (err) {
      logger.warn({ err }, 'Error destroying WhatsApp client');
    }
    try {
      const sessionPath = path.join(process.cwd(), '.wwebjs_auth', `session-agent-${this.agentId}`);
      await fs.remove(sessionPath);
    } catch (err) {
      logger.warn({ err }, 'Failed to remove session auth files');
    }
    this.removeAllListeners();
    this.state = 'destroyed';
  }
}

class WhatsappSessionManager {
  constructor() {
    this.sessions = new Map();
  }

  get(agentId) {
    return this.sessions.get(agentId);
  }

  async createOrUpdateSession({ userId, agentId, agentName, apiKey, aiEndpointUrl }) {
    let session = this.sessions.get(agentId);
    if (session) {
      session.userId = userId;
      session.agentName = agentName;
      session.apiKey = apiKey;
      session.aiEndpointUrl = aiEndpointUrl;
      return { session, created: false };
    }

    session = new WhatsappSession({ userId, agentId, agentName, apiKey, aiEndpointUrl });
    this.sessions.set(agentId, session);

    session.on('disconnected', async () => {
      logger.info({ agentId }, 'Attempting session reconnection');
      try {
        await session.client.initialize();
      } catch (err) {
        logger.error({ err, agentId }, 'Failed to reinitialize WhatsApp session');
      }
    });

    await session.initialize();
    return { session, created: true };
  }

  async deleteSession(agentId) {
    const session = this.sessions.get(agentId);
    if (!session) {
      return false;
    }
    await session.destroy();
    this.sessions.delete(agentId);
    return true;
  }

  async reconnectSession(agentId, { forceQr = true, timeoutMs } = {}) {
    const session = this.sessions.get(agentId);
    if (!session) {
      throw new Error('Session not found');
    }
    if (forceQr) {
      const buffer = await session.refreshQr(timeoutMs);
      return { session, qrBuffer: buffer };
    }
    await session.client.initialize();
    return { session, qrBuffer: session.getQrImage() };
  }
}

module.exports = new WhatsappSessionManager();
