const env = require('../config/env');
const logger = require('../utils/logger');

const DEFAULT_ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const DEFAULT_ALLOWED_HEADERS = ['Authorization', 'Content-Type', 'Accept', 'Origin', 'X-Requested-With'];

function normalizeHeaderValue(values) {
  return Array.from(new Set(values.filter(Boolean))).join(', ');
}

function isOriginAllowed(origin, allowedOrigins) {
  if (!origin) {
    return false;
  }
  if (!allowedOrigins || !allowedOrigins.length) {
    return false;
  }
  if (allowedOrigins.includes('*')) {
    return true;
  }
  return allowedOrigins.some((allowed) => {
    if (!allowed) {
      return false;
    }
    try {
      return new URL(origin).origin === new URL(allowed).origin;
    } catch (err) {
      logger.warn({ err, allowed, origin }, 'Failed to parse CORS origin');
      return allowed === origin;
    }
  });
}

function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  const allowedOrigins = env.corsAllowedOrigins;
  const credentialsAllowed = env.corsAllowCredentials;
  const requestedMethod = req.headers['access-control-request-method'];
  const requestedHeadersRaw = req.headers['access-control-request-headers'];
  const requestedHeaders = requestedHeadersRaw
    ? requestedHeadersRaw.split(',').map((value) => value.trim())
    : [];

  if (origin && isOriginAllowed(origin, allowedOrigins)) {
    res.header('Access-Control-Allow-Origin', allowedOrigins.includes('*') ? '*' : origin);
    res.header('Vary', 'Origin');
    if (credentialsAllowed && !allowedOrigins.includes('*')) {
      res.header('Access-Control-Allow-Credentials', 'true');
    }
  }

  const methodValues = DEFAULT_ALLOWED_METHODS.concat(requestedMethod || []).filter(Boolean);
  const headerValues = DEFAULT_ALLOWED_HEADERS.concat(requestedHeaders).filter(Boolean);

  res.header('Access-Control-Allow-Methods', normalizeHeaderValue(methodValues));
  res.header('Access-Control-Allow-Headers', normalizeHeaderValue(headerValues));
  res.header('Access-Control-Max-Age', '600');

  if (req.method === 'OPTIONS') {
    res.status(204).send();
    return;
  }

  next();
}

module.exports = corsMiddleware;
