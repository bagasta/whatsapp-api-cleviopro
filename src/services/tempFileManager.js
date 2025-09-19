const path = require('path');
const fs = require('fs-extra');
const mime = require('mime-types');
const config = require('../config/env');
const logger = require('../utils/logger');

class TempFileManager {
  constructor(baseDir, ttlMs = 24 * 60 * 60 * 1000) {
    this.baseDir = baseDir;
    this.ttlMs = ttlMs;
    this.cleanupInterval = Math.min(ttlMs / 2, 6 * 60 * 60 * 1000); // at least twice a day
    this.initialized = false;
  }

  async init() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    await fs.ensureDir(this.baseDir);
    await this.cleanup();
    setInterval(() => {
      this.cleanup().catch((err) => logger.error({ err }, 'Failed to cleanup temp files'));
    }, this.cleanupInterval).unref();
  }

  async saveMedia(messageMedia, metadata = {}) {
    if (!messageMedia || !messageMedia.data) {
      return null;
    }

    const extensionFromFile = messageMedia.filename ? path.extname(messageMedia.filename) : '';
    const extensionFromMime = messageMedia.mimetype ? `.${mime.extension(messageMedia.mimetype) || ''}` : '';
    const extension = (extensionFromFile || extensionFromMime || '.bin').replace('..', '.');

    const safeSession = (metadata.sessionId || 'unknown').toString().replace(/[^a-zA-Z0-9_-]/g, '_');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${timestamp}_${safeSession}${extension}`;
    const filePath = path.join(this.baseDir, filename);

    const buffer = Buffer.from(messageMedia.data, 'base64');
    await fs.writeFile(filePath, buffer);

    logger.info({ filePath }, 'Saved temporary media file');
    return filePath;
  }

  async cleanup() {
    const files = await fs.readdir(this.baseDir);
    const threshold = Date.now() - this.ttlMs;
    await Promise.all(
      files.map(async (file) => {
        const filePath = path.join(this.baseDir, file);
        try {
          const stats = await fs.stat(filePath);
          if (stats.isFile() && stats.mtimeMs < threshold) {
            await fs.remove(filePath);
            logger.info({ filePath }, 'Removed expired media file');
          }
        } catch (err) {
          logger.warn({ err, filePath }, 'Failed to inspect temp file');
        }
      })
    );
  }
}

module.exports = new TempFileManager(config.tempDir);
