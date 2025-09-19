const logger = require('../utils/logger');

module.exports = function requestLogger(req, res, next) {
  const start = Date.now();
  const { method, originalUrl } = req;
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  req.requestId = requestId;

  const payloadPreview = (() => {
    if (!req.body || typeof req.body !== 'object') {
      return undefined;
    }
    const clone = { ...req.body };
    if (clone.openai_api_key) {
      clone.openai_api_key = '***';
    }
    if (clone.apiKey) {
      clone.apiKey = '***';
    }
    return clone;
  })();

  logger.info({ requestId, method, url: originalUrl, body: payloadPreview }, 'Incoming request');

  res.on('finish', () => {
    const durationMs = Date.now() - start;
    logger.info(
      {
        requestId,
        method,
        url: originalUrl,
        status: res.statusCode,
        durationMs,
        extra: req.loggerInfo,
      },
      'Request completed'
    );
  });

  next();
};
