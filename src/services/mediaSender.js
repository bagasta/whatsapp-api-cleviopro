const axios = require('axios');
const path = require('path');
const fs = require('fs-extra');
const mime = require('mime-types');
const { MessageMedia } = require('whatsapp-web.js');
const tempFileManager = require('./tempFileManager');
const logger = require('../utils/logger');

async function normalizeMediaInput({ data, url, filename, mimetype }) {
  if (data) {
    if (typeof data !== 'string') {
      throw new Error('data must be a base64-encoded string');
    }
    const buffer = Buffer.from(data, 'base64');
    const detectedMime = mimetype || 'application/octet-stream';
    const resolvedFilename = filename || `file-${Date.now()}.${mime.extension(detectedMime) || 'bin'}`;
    return {
      buffer,
      mimetype: detectedMime,
      filename: resolvedFilename,
    };
  }

  if (url) {
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(response.data);
    const detectedMime = mimetype || response.headers['content-type'] || 'application/octet-stream';
    const urlPath = new URL(url).pathname;
    const inferredName = path.basename(urlPath) || `file-${Date.now()}`;
    const ext = path.extname(inferredName) || `.${mime.extension(detectedMime) || 'bin'}`;
    const resolvedFilename = filename || `${path.basename(inferredName, path.extname(inferredName))}${ext}`;
    return {
      buffer,
      mimetype: detectedMime,
      filename: resolvedFilename,
    };
  }

  throw new Error('data or url is required');
}

async function sendMedia({ session, chatId, type, data, url, filename, caption, mimetype, saveToTemp = true, metadata = {} }) {
  const normalized = await normalizeMediaInput({ data, url, filename, mimetype });

  const media = new MessageMedia(normalized.mimetype, normalized.buffer.toString('base64'), normalized.filename);

  const options = {};
  if (caption && type !== 'sticker') {
    options.caption = caption;
  }
  if (type === 'document') {
    options.sendMediaAsDocument = true;
  }

  const result = await session.client.sendMessage(chatId, media, options);

  let previewPath = null;
  if (saveToTemp) {
    try {
      previewPath = await tempFileManager.saveMedia(
        {
          data: media.data,
          filename: media.filename,
          mimetype: media.mimetype,
        },
        { sessionId: chatId, metadata }
      );
    } catch (err) {
      logger.warn({ err }, 'Failed to persist outbound media preview');
    }
  }

  return { id: result?.id, previewPath };
}

module.exports = {
  sendMedia,
};
