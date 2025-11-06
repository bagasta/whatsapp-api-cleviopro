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
const messageLogService = require('./messageLogService');

const WWEB_CACHE_DIR = path.join(process.cwd(), '.wwebjs_cache');
let lastResolvedWWebVersion = null;

async function resolveVersionFromCache() {
  if (lastResolvedWWebVersion) {
    return lastResolvedWWebVersion;
  }
  try {
    const exists = await fs.pathExists(WWEB_CACHE_DIR);
    if (!exists) {
      return null;
    }
    const entries = await fs.readdir(WWEB_CACHE_DIR);
    if (!entries.length) {
      return null;
    }
    const versions = entries
      .map((entry) => entry.replace(/\.html$/i, '').trim())
      .filter(Boolean)
      .sort();
    lastResolvedWWebVersion = versions.pop() || null;
    return lastResolvedWWebVersion;
  } catch (err) {
    logger.debug({ err }, 'Failed to read cached WhatsApp Web versions from disk');
    return null;
  }
}

if (!Client.prototype._clevioVersionPatchApplied) {
  Client.prototype._clevioVersionPatchApplied = true;
  Client.prototype.getWWebVersion = async function patchedGetWWebVersion() {
    let version = null;
    let evaluationError = null;

    try {
      version = await this.pupPage.evaluate(() => {
        const maybeDebug = typeof window?.Debug?.VERSION === 'string' ? window.Debug.VERSION : null;
        if (maybeDebug) {
          return maybeDebug;
        }
        const maybeStoreArray = window?.Store?.Versions?.default;
        if (Array.isArray(maybeStoreArray)) {
          const first = maybeStoreArray.find((entry) => typeof entry?.version === 'string' && entry.version.length);
          if (first && first.version) {
            return first.version;
          }
        }
        const connVersion =
          window?.Store?.Conn?.attributes && typeof window.Store.Conn.attributes?.webVersion === 'string'
            ? window.Store.Conn.attributes.webVersion
            : null;
        if (connVersion) {
          return connVersion;
        }
        return null;
      });
    } catch (err) {
      evaluationError = err;
    }

    if (typeof version === 'string' && version.length > 0) {
      lastResolvedWWebVersion = version;
      if (!this.options.webVersion) {
        this.options.webVersion = version;
      }
      return version;
    }

    const cachedVersion = await resolveVersionFromCache();
    if (cachedVersion) {
      logger.info({ cachedVersion }, 'Using cached WhatsApp Web version');
      this.options.webVersion = cachedVersion;
      return cachedVersion;
    }

    const optionVersion =
      typeof this.options?.webVersion === 'string' && this.options.webVersion.length ? this.options.webVersion : null;
    if (optionVersion) {
      lastResolvedWWebVersion = optionVersion;
      return optionVersion;
    }

    const fallbackVersion = '2.3000.0';
    lastResolvedWWebVersion = fallbackVersion;
    if (evaluationError) {
      logger.warn({ err: evaluationError }, 'Falling back to default WhatsApp Web version string');
    } else {
      logger.warn('Unable to determine WhatsApp Web version; using default fallback');
    }
    this.options.webVersion = fallbackVersion;
    return fallbackVersion;
  };
}

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
    this.firstQrProvided = false;
    this.refreshing = false;
    this.reconnecting = false;
    this.hasEverBeenReady = false;
    this.reconnectPromise = null;
    this.awaitingAuthentication = false;
    this.qrExpiryTimer = null;
    this.connectedPersisted = false;
    this.disconnectedPersisted = false;
    this.reconnectLock = false;
    this.expectedDisconnectReason = null;
    this.expectedDisconnectResetTimer = null;
    this.reconnectAuthorized = false;
    this.reconnectAuthorizationReason = null;
    this.client = this.buildClient();
    this.registerEvents(this.client);
    this.logLifecycle('constructor_initialized', 'debug', { hasClient: Boolean(this.client) });
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

  isReady() {
    return this.state === 'ready';
  }

  isAwaitingAuthentication() {
    return this.awaitingAuthentication === true;
  }

  markAwaitingAuthentication() {
    this.awaitingAuthentication = true;
    this.disconnectedPersisted = false;
    this.connectedPersisted = false;
  }

  clearAwaitingAuthentication() {
    this.awaitingAuthentication = false;
  }

  logLifecycle(event, level = 'info', extra = {}) {
    const payload = {
      agentId: this.agentId,
      state: this.state,
      awaitingAuthentication: this.awaitingAuthentication,
      reconnecting: this.reconnecting,
      refreshing: this.refreshing,
      hasClient: Boolean(this.client),
      reconnectLock: this.reconnectLock,
      reconnectAuthorized: this.reconnectAuthorized,
      hasEverBeenReady: this.hasEverBeenReady,
      ...extra,
    };
    const message = `WhatsApp session lifecycle: ${event}`;
    if (typeof logger[level] === 'function') {
      logger[level](payload, message);
    } else {
      logger.info(payload, message);
    }
  }

  static isBroadcastOrStatusAddress(value) {
    if (typeof value !== 'string') {
      return false;
    }
    const lower = value.toLowerCase();
    return (
      lower === 'status@broadcast' ||
      lower.endsWith('@broadcast') ||
      lower.endsWith('@status')
    );
  }

  isBroadcastOrStatusMessage(message) {
    if (!message) {
      return false;
    }
    if (message.broadcast === true || message.isStatus === true) {
      return true;
    }
    if (
      WhatsappSession.isBroadcastOrStatusAddress(message.from) ||
      WhatsappSession.isBroadcastOrStatusAddress(message.to) ||
      WhatsappSession.isBroadcastOrStatusAddress(message.author)
    ) {
      return true;
    }
    const remoteId =
      typeof message.id?.remote === 'string'
        ? message.id.remote
        : typeof message.id?._serialized === 'string'
          ? message.id._serialized
          : null;
    if (remoteId && WhatsappSession.isBroadcastOrStatusAddress(remoteId)) {
      return true;
    }
    return false;
  }

  hasReadyHistory() {
    return this.hasEverBeenReady === true;
  }

  async resetAfterQrExpiry({ removeAuthFiles = true } = {}) {
    this.clearAwaitingAuthentication();
    this.clearQrExpiryTimer();
    this.currentQr = null;
    this.firstQrProvided = false;
    this.refreshing = false;
    this.reconnecting = false;
    this.reconnectPromise = null;
    this.reconnectLock = false;
    this.me = null;
    this.revokeReconnectAuthorization();
    this.logLifecycle('reset_after_qr_expiry:start', 'info', { removeAuthFiles });

    try {
      if (this.client) {
        await this.destroyCurrentClient({
          skipLogout: true,
          removeAuthFiles,
          allowConnectedDestroy: true,
          reason: 'qr_expired_cleanup',
        });
      }
    } catch (err) {
      logger.warn({ err, agentId: this.agentId }, 'Failed to dispose WhatsApp client after QR expiry');
    }

    if (this.state !== 'destroyed' && this.state !== 'auth_failed') {
      this.state = 'disconnected';
    }

    this.connectedPersisted = false;
    this.disconnectedPersisted = false;
    this.logLifecycle('reset_after_qr_expiry:complete', 'info', { removeAuthFiles });
  }

  clearQrExpiryTimer() {
    if (this.qrExpiryTimer) {
      clearTimeout(this.qrExpiryTimer);
      this.qrExpiryTimer = null;
    }
  }

  startQrExpiryTimer() {
    const ttl = config.qrExpirationMinutes * 60 * 1000;
    this.clearQrExpiryTimer();
    this.qrExpiryTimer = setTimeout(() => this.handleQrExpiryTimeout(), ttl);
    if (typeof this.qrExpiryTimer?.unref === 'function') {
      this.qrExpiryTimer.unref();
    }
  }

  handleQrExpiryTimeout() {
    this.qrExpiryTimer = null;
    if (!this.isAwaitingAuthentication() || this.isReady()) {
      logger.debug({ agentId: this.agentId }, 'QR expiry timer fired but session is already authenticated; ignoring');
      return;
    }
    this.clearAwaitingAuthentication();
    this.currentQr = null;
    this.emit('qr_expired');
  }

  handleClientReady() {
    if (this.state === 'ready' && this.hasEverBeenReady) {
      this.logLifecycle('handle_client_ready:duplicate_ignored', 'debug', { me: this.me });
      return;
    }
    this.state = 'ready';
    this.me = this.client?.info?.wid?._serialized;
    this.markReadyFlags();
    this.emit('ready');
    if (!this.connectedPersisted) {
      this.connectedPersisted = true;
      updateStatus(this.agentId, { status: 'connected', lastConnectedAt: new Date() }).catch((err) => {
        this.connectedPersisted = false;
        logger.warn({ err, agentId: this.agentId }, 'Failed to persist connected status');
      });
    }
    this.logLifecycle('handle_client_ready', 'info', { me: this.me });
  }

  markReadyFlags() {
    this.clearAwaitingAuthentication();
    this.clearQrExpiryTimer();
    this.clearExpectedDisconnect();
    this.currentQr = null;
    this.firstQrProvided = false;
    this.hasEverBeenReady = true;
    this.refreshing = false;
    this.reconnecting = false;
    this.reconnectPromise = null;
    this.reconnectLock = false;
    this.disconnectedPersisted = false;
    this.revokeReconnectAuthorization();
  }

  setExpectedDisconnect(reason) {
    this.clearExpectedDisconnect();
    if (!reason) {
      return;
    }
    this.expectedDisconnectReason = reason;
    this.expectedDisconnectResetTimer = setTimeout(() => {
      if (this.expectedDisconnectReason === reason) {
        logger.debug({ agentId: this.agentId, reason }, 'Clearing expected disconnect flag after timeout');
        this.expectedDisconnectReason = null;
        this.expectedDisconnectResetTimer = null;
      }
    }, 30_000);
    if (typeof this.expectedDisconnectResetTimer?.unref === 'function') {
      this.expectedDisconnectResetTimer.unref();
    }
  }

  clearExpectedDisconnect() {
    if (this.expectedDisconnectResetTimer) {
      clearTimeout(this.expectedDisconnectResetTimer);
      this.expectedDisconnectResetTimer = null;
    }
    this.expectedDisconnectReason = null;
  }

  authorizeReconnect(reason = 'manual_reconnect') {
    this.reconnectAuthorized = true;
    this.reconnectAuthorizationReason = reason;
    this.logLifecycle('authorize_reconnect', 'info', { reason });
  }

  revokeReconnectAuthorization() {
    if (this.reconnectAuthorized) {
      this.logLifecycle('revoke_reconnect_authorization', 'info', {
        reason: this.reconnectAuthorizationReason,
      });
    }
    this.reconnectAuthorized = false;
    this.reconnectAuthorizationReason = null;
  }

  isReconnectAuthorized() {
    return this.reconnectAuthorized === true;
  }

  async handleClientDisconnected(reason) {
    const expectedReason = this.expectedDisconnectReason;
    const controlled = Boolean(expectedReason);
    const reasonCode = typeof reason === 'string' ? reason.toUpperCase() : '';
    this.clearExpectedDisconnect();
    this.logLifecycle('handle_client_disconnected:start', controlled ? 'info' : 'warn', {
      reason,
      expectedReason,
      controlled,
    });
    if (!controlled) {
      this.state = 'disconnected';
    }
    this.clearAwaitingAuthentication();
    this.clearQrExpiryTimer();
    this.currentQr = null;
    this.firstQrProvided = false;
    this.connectedPersisted = false;
    this.revokeReconnectAuthorization();
    this.me = null;
    if (controlled) {
      logger.info({ agentId: this.agentId, reason, expectedReason }, 'Controlled WhatsApp session disconnect observed');
    } else {
      logger.warn({ agentId: this.agentId, reason }, 'WhatsApp session disconnected');
    }
    this.emit('disconnected', reason);
    this.refreshing = false;
    this.reconnecting = false;
    this.reconnectPromise = null;
    this.reconnectLock = false;
    const normalizedReason = reasonCode || 'UNKNOWN';
    const shouldRemoveAuthFiles = ['LOGOUT', 'TOS_BLOCK', 'SMB_TOS_BLOCK', 'UNPAIRED', 'MULTI_DEVICE_MISMATCH'].includes(
      normalizedReason
    );
    if (!controlled) {
      this.logLifecycle('handle_client_disconnected:unexpected', 'warn', {
        normalizedReason,
        shouldRemoveAuthFiles,
      });
      if (!this.disconnectedPersisted) {
        this.disconnectedPersisted = true;
        updateStatus(this.agentId, { status: 'disconnected', lastDisconnectedAt: new Date() }).catch((err) => {
          this.disconnectedPersisted = false;
          logger.warn({ err, agentId: this.agentId }, 'Failed to persist disconnected status');
        });
      }
      try {
        await this.destroyCurrentClient({
          skipLogout: true,
          removeAuthFiles: shouldRemoveAuthFiles,
          allowConnectedDestroy: true,
          reason: `post_disconnect_${normalizedReason}`,
        });
      } catch (err) {
        logger.warn({ err, agentId: this.agentId, reason: normalizedReason }, 'Failed to dispose client after disconnect');
      }
      this.logLifecycle('handle_client_disconnected:client_disposed', 'info', {
        normalizedReason,
        shouldRemoveAuthFiles,
      });
    } else {
      this.disconnectedPersisted = false;
    }
    this.logLifecycle('handle_client_disconnected:complete', 'info', { reason, controlled });
  }

  registerEvents(client) {
    client.on('qr', async (qr) => {
      if (this.isReady()) {
        logger.info({ agentId: this.agentId }, 'Ignoring QR event because session is already ready');
        return;
      }
      try {
        const buffer = await qrcode.toBuffer(qr, { type: 'png', width: 300 });
        const expiresAt = Date.now() + config.qrExpirationMinutes * 60 * 1000;
        this.state = 'qr';
        this.markAwaitingAuthentication();
        this.currentQr = { buffer, generatedAt: Date.now(), expiresAt };
        const firstEmission = !this.firstQrProvided;
        this.firstQrProvided = true;
        this.startQrExpiryTimer();
        this.emit('qr', this.currentQr);
        logger.info(
          { agentId: this.agentId, refreshed: !firstEmission },
          firstEmission ? 'QR code generated' : 'QR code refreshed before authentication'
        );
        updateStatus(this.agentId, { status: 'awaiting_qr' }).catch((err) =>
          logger.warn({ err, agentId: this.agentId }, 'Failed to persist QR awaiting status')
        );
      } catch (err) {
        logger.error({ err }, 'Failed to generate QR code image');
      }
    });

    client.on('ready', () => {
      this.handleClientReady();
      logger.info({ agentId: this.agentId }, 'WhatsApp session ready');
    });

    client.on('authenticated', () => {
      logger.info({ agentId: this.agentId }, 'WhatsApp session authenticated');
    });

    client.on('auth_failure', (msg) => {
      this.logLifecycle('auth_failure', 'error', { msg });
      logger.error({ agentId: this.agentId, msg }, 'Authentication failure');
      this.state = 'auth_failed';
      this.clearAwaitingAuthentication();
      this.clearQrExpiryTimer();
      this.connectedPersisted = false;
      this.disconnectedPersisted = true;
      this.revokeReconnectAuthorization();
      this.emit('auth_failure', msg);
      this.currentQr = null;
      this.firstQrProvided = false;
      updateStatus(this.agentId, { status: 'auth_failed', lastDisconnectedAt: new Date() }).catch((err) =>
        logger.warn({ err, agentId: this.agentId }, 'Failed to persist auth failure status')
      );
    });

    client.on('disconnected', (reason) => {
      this.handleClientDisconnected(reason).catch((err) => {
        logger.error({ err, agentId: this.agentId, reason }, 'Unhandled error while processing WhatsApp disconnect');
      });
    });

    client.on('message_create', (message) => {
      if (this.isBroadcastOrStatusMessage(message)) {
        logger.debug(
          {
            agentId: this.agentId,
            messageId: message?.id?._serialized,
            from: message?.from,
            to: message?.to,
          },
          'Ignoring broadcast/status message_create event'
        );
      }
    });

    client.on('message', (message) => {
      this.handleIncomingMessage(message).catch((err) => {
        logger.error({ err, agentId: this.agentId }, 'Failed to handle incoming message');
      });
    });
  }

  async destroyCurrentClient({
    skipLogout = false,
    removeAuthFiles = false,
    allowConnectedDestroy = false,
    reason = 'unspecified',
  } = {}) {
    const allowDestroy = allowConnectedDestroy || this.isReconnectAuthorized();
    if (this.isReady() && !allowDestroy) {
      logger.debug({ agentId: this.agentId, reason }, 'Refusing to destroy ready session without explicit permission');
      this.logLifecycle('destroy_current_client:refused_ready', 'debug', { reason, allowConnectedDestroy });
      return false;
    }

    const previousClient = this.client;
    this.logLifecycle('destroy_current_client:start', 'info', {
      skipLogout,
      removeAuthFiles,
      allowConnectedDestroy,
      reason,
      hadClient: Boolean(previousClient),
    });

    this.clearQrExpiryTimer();
    this.clearAwaitingAuthentication();

    if (previousClient) {
      this.setExpectedDisconnect(reason || 'controlled_teardown');
      try {
        if (!skipLogout && typeof previousClient.logout === 'function') {
          await previousClient.logout();
        }
      } catch (err) {
        logger.debug({ err, agentId: this.agentId }, 'Logout during client teardown failed, continuing');
      }

      if (typeof previousClient.removeAllListeners === 'function') {
        previousClient.removeAllListeners();
      }

      try {
        await previousClient.destroy();
      } catch (err) {
        logger.warn({ err, agentId: this.agentId }, 'Error destroying WhatsApp client during teardown');
        this.clearExpectedDisconnect();
      }
    }

    if (removeAuthFiles) {
      try {
        const sessionPath = path.join(process.cwd(), '.wwebjs_auth', `session-agent-${this.agentId}`);
        await fs.remove(sessionPath);
      } catch (err) {
        logger.debug({ err, agentId: this.agentId }, 'Failed to remove session auth files');
      }
    }

    this.client = null;
    this.initialized = false;
    this.logLifecycle('destroy_current_client:complete', 'info', {
      skipLogout,
      removeAuthFiles,
      allowConnectedDestroy,
      reason,
    });
    return true;
  }

  async createClientAndInitialize() {
    if (this.isReady() && this.client) {
      logger.debug({ agentId: this.agentId }, 'Skipping client initialization; session already ready');
      return this.client;
    }
    const hadExistingClient = Boolean(this.client);
    const nextClient = this.buildClient();
    this.client = nextClient;
    this.logLifecycle('create_client_and_initialize:start', 'info', {
      hadExistingClient,
    });
    this.registerEvents(nextClient);
    await tempFileManager.init();
    await nextClient.initialize();
    this.logLifecycle('create_client_and_initialize:complete', 'info', { success: true });
    return nextClient;
  }

  waitForReadyOrQr(timeoutMs = 15000) {
    if (this.state === 'ready') {
      return Promise.resolve('ready');
    }

    return new Promise((resolve, reject) => {
      const onReady = () => {
        cleanup();
        resolve('ready');
      };
      const onQr = () => {
        cleanup();
        resolve('qr');
      };
      const onAuthFailure = (msg) => {
        cleanup();
        const error = new Error(typeof msg === 'string' ? msg : 'Authentication failure');
        reject(error);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for WhatsApp client to become ready'));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        this.off('ready', onReady);
        this.off('qr', onQr);
        this.off('auth_failure', onAuthFailure);
      };

      this.on('ready', onReady);
      this.on('qr', onQr);
      this.on('auth_failure', onAuthFailure);
    });
  }

  async initialize() {
    if (this.initialized) {
      this.logLifecycle('initialize:skip_already_initialized', 'debug');
      return;
    }
    if (this.isReady()) {
      logger.debug({ agentId: this.agentId }, 'Session already ready; skipping initialize');
      this.initialized = true;
      this.logLifecycle('initialize:skip_already_ready', 'debug');
      return;
    }
    this.initialized = true;
    this.logLifecycle('initialize:start', 'info');
    await tempFileManager.init();
    await this.client.initialize();
    this.logLifecycle('initialize:complete', 'info');
  }

  getQrImage() {
    if (this.state === 'ready') {
      return null;
    }
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

  async refreshQr({ timeoutMs = 60_000, skipLogout = false } = {}) {
    if (this.isReady()) {
      logger.debug({ agentId: this.agentId }, 'Skipping QR refresh; session already ready');
      return null;
    }
    this.logLifecycle('refresh_qr:start', 'info', { timeoutMs, skipLogout });
    if (!this.isReconnectAuthorized()) {
      const err = new Error('Reconnect not authorized');
      err.code = 'RECONNECT_NOT_AUTHORIZED';
      err.status = 409;
      this.logLifecycle('refresh_qr:not_authorized', 'warn', { timeoutMs, skipLogout });
      throw err;
    }
    if (this.refreshing) {
      this.logLifecycle('refresh_qr:reuse_existing_waiter', 'info', { timeoutMs });
      return this.waitForQr(timeoutMs);
    }
    this.refreshing = true;
    if (this.reconnectLock) {
      logger.debug({ agentId: this.agentId }, 'QR refresh requested while another reconnect operation is in progress; aborting refresh');
      this.refreshing = false;
      const err = new Error('Reconnect already in progress');
      err.code = 'RECONNECT_IN_PROGRESS';
      err.status = 409;
      this.logLifecycle('refresh_qr:blocked_by_lock', 'warn', { timeoutMs });
      throw err;
    }
    this.reconnectPromise = null;
    this.reconnectLock = true;
    this.currentQr = null;
    this.firstQrProvided = false;
    this.me = null;

    await this.destroyCurrentClient({ skipLogout, removeAuthFiles: true, reason: 'refresh_qr_teardown' });
    this.state = 'initializing';

    const waitQrPromise = this.waitForQr(timeoutMs);

    try {
      await this.createClientAndInitialize();
      const buffer = await waitQrPromise;
      this.logLifecycle('refresh_qr:complete', 'info', { qrProvided: Boolean(buffer) });
      return buffer;
    } catch (err) {
      if (err && typeof err.message === 'string' && err.message.includes('Session already authenticated')) {
        logger.debug({ agentId: this.agentId }, 'Session became ready before QR refresh completed');
        this.logLifecycle('refresh_qr:already_ready', 'info');
        return null;
      }
      logger.error({ err, agentId: this.agentId }, 'Failed to initialize WhatsApp client during QR refresh');
      this.logLifecycle('refresh_qr:error', 'error', { message: err?.message });
      throw err;
    } finally {
      this.reconnectLock = false;
      this.refreshing = false;
      this.logLifecycle('refresh_qr:finally', 'info', {
        reconnectLock: this.reconnectLock,
        refreshing: this.refreshing,
      });
    }
  }

  async reconnectUsingStoredAuth({ timeoutMs = 30_000 } = {}) {
    if (this.isReady()) {
      logger.debug({ agentId: this.agentId }, 'Skipping stored auth reconnect; session already ready');
      return true;
    }
    this.logLifecycle('reconnect_using_stored_auth:start', 'info', { timeoutMs });
    if (!this.isReconnectAuthorized()) {
      const err = new Error('Reconnect not authorized');
      err.code = 'RECONNECT_NOT_AUTHORIZED';
      err.status = 409;
      this.logLifecycle('reconnect_using_stored_auth:not_authorized', 'warn');
      throw err;
    }
    if (this.reconnectPromise) {
      this.logLifecycle('reconnect_using_stored_auth:reuse_existing', 'info');
      return this.reconnectPromise;
    }
    if (this.reconnectLock) {
      const err = new Error('Reconnect already in progress');
      err.code = 'RECONNECT_IN_PROGRESS';
      err.status = 409;
      this.logLifecycle('reconnect_using_stored_auth:blocked_by_lock', 'warn');
      throw err;
    }
    this.reconnectLock = true;

    const attempt = async () => {
      this.reconnecting = true;
      this.currentQr = null;
      this.firstQrProvided = false;
      this.me = null;

      try {
        await this.destroyCurrentClient({
          skipLogout: true,
          removeAuthFiles: false,
          reason: 'reconnect_teardown',
        });
        this.state = 'initializing';
        const outcomePromise = this.waitForReadyOrQr(timeoutMs);
        await this.createClientAndInitialize();
        const outcome = await outcomePromise;
        if (outcome !== 'ready') {
          const qrError = new Error('Session requires QR reauthentication');
          qrError.requiresQr = true;
          qrError.qrAvailable = Boolean(this.currentQr);
          this.logLifecycle('reconnect_using_stored_auth:requires_qr', 'info', {
            qrAvailable: qrError.qrAvailable,
          });
          throw qrError;
        }
        this.logLifecycle('reconnect_using_stored_auth:ready', 'info');
        return true;
      } finally {
        this.reconnecting = false;
      }
    };

    const runPromise = (async () => {
      try {
        return await attempt();
      } finally {
        this.reconnectLock = false;
      }
    })();

    this.reconnectPromise = runPromise;

    try {
      const result = await runPromise;
      this.logLifecycle('reconnect_using_stored_auth:complete', 'info', { success: result === true });
      return result;
    } finally {
      if (this.reconnectPromise === runPromise) {
        this.reconnectPromise = null;
      }
      this.logLifecycle('reconnect_using_stored_auth:settled', 'info', {
        reconnectLock: this.reconnectLock,
        reconnectPromise: Boolean(this.reconnectPromise),
      });
    }
  }

  async handleIncomingMessage(message) {
    if (!message) {
      logger.debug({ agentId: this.agentId }, 'Ignoring null message payload');
      return;
    }

    if (this.isBroadcastOrStatusMessage(message)) {
      logger.debug(
        {
          agentId: this.agentId,
          messageId: message?.id?._serialized,
          from: message?.from,
          to: message?.to,
          broadcast: message?.broadcast,
          isStatus: message?.isStatus,
        },
        'Ignoring broadcast/status message'
      );
      return;
    }

    if (message.fromMe) {
      logger.debug({ agentId: this.agentId, messageId: message.id?._serialized }, 'Ignoring message from self');
      return;
    }

    logger.info(
      {
        agentId: this.agentId,
        messageId: message.id?._serialized,
        from: message.from,
        fromMe: message.fromMe,
        type: message.type,
        hasBody: !!message.body,
        body: message.body?.substring(0, 50)
      },
      'handleIncomingMessage called'
    );

    let chat;
    try {
      chat = await message.getChat();
    } catch (err) {
      logger.warn({ err, agentId: this.agentId }, 'Skipping message; failed to resolve chat context');
      return;
    }

    if (message.broadcast || chat.isBroadcast || chat.isStatus) {
      logger.debug(
        {
          agentId: this.agentId,
          broadcast: message.broadcast,
          chatId: chat.id?._serialized,
          isBroadcast: chat.isBroadcast,
          isStatus: chat.isStatus,
        },
        'Ignoring broadcast message'
      );
      return;
    }

    let contact = null;
    try {
      contact = await message.getContact();
    } catch (err) {
      logger.debug({ err, agentId: this.agentId }, 'Unable to resolve contact info; continuing without it');
    }

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
      const normalizeId = (raw) => {
        if (!raw) return '';
        if (typeof raw === 'string') return raw;
        if (typeof raw === 'object') {
          if (typeof raw._serialized === 'string') {
            return raw._serialized;
          }
          if (raw.id) {
            const nested = normalizeId(raw.id);
            if (nested) {
              return nested;
            }
          }
        }
        return '';
      };
      const mentionedIds = new Set(
        (message.mentionedIds || [])
          .map((id) => normalizeId(id))
          .filter(Boolean)
      );
      if (!mentionedIds.size) {
        try {
          const mentions = await message.getMentions();
          if (Array.isArray(mentions)) {
            mentions.forEach((mention) => {
              const key = normalizeId(mention?.id || mention);
              if (key) {
                mentionedIds.add(key);
              }
            });
          }
        } catch (err) {
          logger.debug({ err, agentId: this.agentId }, 'Failed to resolve mention list for group message');
        }
      }
      if (!mentionedIds.has(botId)) {
        const explicitHandles = (message.body || '').match(/@\S+/g) || [];
        if (explicitHandles.length) {
          let participants = Array.isArray(chat.participants) ? chat.participants : [];
          if ((!participants || !participants.length) && typeof chat.getParticipants === 'function') {
            try {
              const fetched = await chat.getParticipants();
              if (Array.isArray(fetched) && fetched.length) {
                participants = fetched;
              }
            } catch (err) {
              logger.debug({ err, agentId: this.agentId }, 'Failed to pull participant roster for mention resolution');
            }
          }

          const rosterTokenSet = new Set();
          const rosterNumericSet = new Set();
          const addRosterTokens = (rawId) => {
            const normalized = normalizeId(rawId);
            if (!normalized) {
              return;
            }
            const lower = normalized.toLowerCase();
            rosterTokenSet.add(lower);
            const numberPart = lower.split('@')[0];
            if (numberPart) {
              rosterTokenSet.add(numberPart);
              const digitsOnly = numberPart.replace(/\D+/g, '');
              if (digitsOnly) {
                rosterNumericSet.add(digitsOnly);
              }
            }
            const normalizedDigits = lower.replace(/\D+/g, '');
            if (normalizedDigits) {
              rosterNumericSet.add(normalizedDigits);
            }
          };

          participants.forEach((participant) => addRosterTokens(participant?.id || participant));
          addRosterTokens(botId);

          const botNumber = botId.split('@')[0] || '';
          const botNumberDigits = botNumber.replace(/\D+/g, '');
          if (botNumber) {
            rosterTokenSet.add(botNumber.toLowerCase());
          }
          if (botNumberDigits) {
            rosterNumericSet.add(botNumberDigits);
          }

          const mentionMatchesBot = explicitHandles.some((handle) => {
            const trimmed = handle.replace(/^@+/, '');
            if (!trimmed) {
              return false;
            }
            const sanitized = trimmed.replace(/[^0-9a-z]/gi, '');
            if (!sanitized) {
              return false;
            }
            const lower = sanitized.toLowerCase();
            const digitsOnly = lower.replace(/\D+/g, '');
            return rosterTokenSet.has(lower) || (digitsOnly && rosterNumericSet.has(digitsOnly));
          });

          if (mentionMatchesBot) {
            mentionedIds.add(botId);
          }
        }
      }
      if (!mentionedIds.size || !mentionedIds.has(botId)) {
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

    messageLogService.record({
      direction: 'inbound',
      agentId: this.agentId,
      messageId: message.id?._serialized,
      sessionId,
      from: message.from,
      type: message.type,
      body: trimmed,
      hasMedia: Boolean(message.hasMedia),
      isGroup: metadata.is_group,
      metadata,
      extra: {
        contactNumber: contact?.number || null,
        contactName: metadata.whatsapp_name,
        chatName: metadata.chat_name,
      },
    });

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
        messageLogService.record({
          direction: 'outbound',
          agentId: this.agentId,
          sessionId,
          to: message.from,
          type: 'chat',
          body: replyText,
          metadata: {
            replyTo: message.id?._serialized,
            isGroup: metadata.is_group,
          },
          aiResponse:
            typeof aiResponse === 'string' ? aiResponse : JSON.stringify(aiResponse, null, 2).slice(0, 2000),
        });
      } catch (err) {
        logger.error({ err, agentId: this.agentId }, 'Failed to send AI reply back to chat');
      }
    }
  }

  async destroy({ reason = 'manual_destroy' } = {}) {
    await this.destroyCurrentClient({
      skipLogout: true,
      removeAuthFiles: true,
      allowConnectedDestroy: true,
      reason,
    });
    this.removeAllListeners();
    this.state = 'destroyed';
    this.hasEverBeenReady = false;
    this.initialized = false;
    this.refreshing = false;
    this.reconnecting = false;
    this.reconnectPromise = null;
    this.reconnectLock = false;
    this.awaitingAuthentication = false;
    this.clearQrExpiryTimer();
    this.clearExpectedDisconnect();
    this.currentQr = null;
    this.firstQrProvided = false;
    this.connectedPersisted = false;
    this.disconnectedPersisted = false;
    this.revokeReconnectAuthorization();
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
      logger.info(
        {
          agentId,
          existingState: session.state,
          hasClient: Boolean(session.client),
        },
        'Updating existing WhatsApp session metadata'
      );
      session.userId = userId;
      session.agentName = agentName;
      session.apiKey = apiKey;
      session.aiEndpointUrl = aiEndpointUrl;
      if (typeof session.revokeReconnectAuthorization === 'function') {
        session.revokeReconnectAuthorization();
      }
      return { session, created: false };
    }

    logger.info({ agentId, hasClient: false }, 'Creating new WhatsApp session entry');
    session = new WhatsappSession({ userId, agentId, agentName, apiKey, aiEndpointUrl });
    session.revokeReconnectAuthorization();
    this.sessions.set(agentId, session);

    session.on('disconnected', async (reason) => {
      if (session.refreshing) {
        logger.debug({ agentId, reason }, 'Disconnection observed during QR refresh; ignoring due to active refresh');
        return;
      }

      if (session.reconnecting || session.reconnectLock) {
        logger.debug({ agentId, reason }, 'Disconnection observed while reconnect mutex held; ignoring');
        return;
      }

      logger.info({ agentId, reason }, 'Auto reconnect disabled; awaiting explicit manual reconnect');
    });

    await session.initialize();
    logger.info({ agentId, state: session.state }, 'WhatsApp session initialized and tracked');
    return { session, created: true };
  }

  async deleteSession(agentId) {
    const session = this.sessions.get(agentId);
    if (!session) {
      logger.info({ agentId }, 'Delete session requested but no live session found');
      return false;
    }
    if (typeof session.revokeReconnectAuthorization === 'function') {
      session.revokeReconnectAuthorization();
    }
    logger.info({ agentId }, 'Deleting WhatsApp session');
    await session.destroy({ reason: 'delete_session' });
    this.sessions.delete(agentId);
    logger.info({ agentId }, 'WhatsApp session deleted and removed from registry');
    return true;
  }

  async reconnectSession(agentId, { forceQr, timeoutMs } = {}) {
    logger.info({ agentId, forceQr, timeoutMs }, 'Manual reconnect requested');
    const session = this.sessions.get(agentId);
    if (!session) {
      throw new Error('Session not found');
    }
    if (typeof session.isReady === 'function' ? session.isReady() : session.state === 'ready') {
      const err = new Error('Session is already connected');
      err.status = 409;
      throw err;
    }
    const shouldAttemptStoredAuth = forceQr !== true;

    session.authorizeReconnect('manual_reconnect_endpoint');
    try {
      if (shouldAttemptStoredAuth) {
        try {
          await session.reconnectUsingStoredAuth({ timeoutMs });
          logger.info({ agentId }, 'Stored credentials reconnect succeeded');
          return { session, qrBuffer: session.getQrImage() };
        } catch (err) {
          if (forceQr === false || !err?.requiresQr) {
            throw err;
          }
          logger.info({ agentId }, 'Stored auth reconnect failed; regenerating QR');
        }
      }

      const buffer = await session.refreshQr({ timeoutMs, skipLogout: shouldAttemptStoredAuth });
      logger.info({ agentId, qrProvided: Boolean(buffer) }, 'QR refresh completed for manual reconnect');
      return { session, qrBuffer: buffer };
    } finally {
      session.revokeReconnectAuthorization();
    }
  }
}

module.exports = new WhatsappSessionManager();
