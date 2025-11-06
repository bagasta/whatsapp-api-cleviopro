const env = require('../config/env');
const logger = require('../utils/logger');

class MessageLogService {
  constructor({ maxEntries = 2000 } = {}) {
    this.maxEntries = Number.isFinite(maxEntries) && maxEntries > 0 ? maxEntries : 2000;
    this.entries = [];
  }

  setMaxEntries(maxEntries) {
    if (!Number.isFinite(maxEntries) || maxEntries <= 0) {
      return;
    }
    this.maxEntries = Math.floor(maxEntries);
    this.trim();
  }

  record(entry) {
    if (!entry || typeof entry !== 'object') {
      return;
    }
    const normalized = {
      direction: entry.direction || 'unknown',
      agentId: entry.agentId || null,
      messageId: entry.messageId || null,
      sessionId: entry.sessionId || null,
      from: entry.from || null,
      to: entry.to || null,
      type: entry.type || null,
      bodyPreview: entry.body ? entry.body.slice(0, 500) : null,
      hasMedia: entry.hasMedia === true,
      isGroup: entry.isGroup === true,
      metadata: entry.metadata || null,
      aiResponsePreview: entry.aiResponse ? entry.aiResponse.slice(0, 500) : null,
      timestamp: entry.timestamp || new Date().toISOString(),
      extra: entry.extra || null,
    };
    this.entries.push(normalized);
    this.trim();
  }

  trim() {
    if (this.entries.length > this.maxEntries) {
      const removeCount = this.entries.length - this.maxEntries;
      this.entries.splice(0, removeCount);
      logger.debug({ removeCount, newLength: this.entries.length }, 'Trimmed message log entries');
    }
  }

  list({ agentId, limit, direction } = {}) {
    let result = this.entries;
    if (agentId) {
      const lowerAgentId = agentId.toLowerCase();
      result = result.filter((entry) => (entry.agentId || '').toLowerCase() === lowerAgentId);
    }
    if (direction) {
      const normalizedDirection = direction.toLowerCase();
      result = result.filter((entry) => String(entry.direction || '').toLowerCase() === normalizedDirection);
    }

    if (Number.isFinite(limit) && limit > 0) {
      const sliceStart = result.length - Math.min(result.length, Math.floor(limit));
      result = result.slice(Math.max(0, sliceStart));
    }

    return result;
  }

  clear() {
    this.entries = [];
  }
}

const messageLogService = new MessageLogService({ maxEntries: env.messageLogMaxEntries });

module.exports = messageLogService;
