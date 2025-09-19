const logger = require('../utils/logger');

function errorHandler(err, req, res, next) {
  logger.error({ err }, 'Unhandled error');
  const status = err.status || 500;
  const payload = {
    error: err.message || 'Internal Server Error',
  };
  if (err.details) {
    payload.details = err.details;
  }
  res.status(status).json(payload);
}

module.exports = errorHandler;
