const axios = require('axios');
const config = require('../config/env');
const logger = require('../utils/logger');

const warmPromises = new Map();

function getWarmEndpoint(endpointUrl) {
  if (!endpointUrl) {
    return null;
  }
  try {
    const urlObj = new URL(endpointUrl);
    const trimmedPath = urlObj.pathname.replace(/\/$/, '');
    if (/\/run$/.test(trimmedPath)) {
      urlObj.pathname = trimmedPath.replace(/\/run$/, '/warm');
    } else {
      urlObj.pathname = `${trimmedPath.replace(/\/$/, '')}/warm`;
    }
    return urlObj.toString();
  } catch (err) {
    if (/\/run(?:\/)?$/.test(endpointUrl)) {
      return endpointUrl.replace(/\/run(?:\/)?$/, '/warm');
    }
    return `${endpointUrl.replace(/\/$/, '')}/warm`;
  }
}

function shouldWarmForError(err) {
  const data = err?.response?.data;
  if (!data) {
    return false;
  }
  const candidates = [];
  if (typeof data === 'string') {
    candidates.push(data);
  } else if (typeof data === 'object') {
    ['detail', 'message', 'error'].forEach((key) => {
      if (typeof data[key] === 'string') {
        candidates.push(data[key]);
      }
    });
  }
  return candidates.some((text) => /warm/i.test(text) || /config not cached/i.test(text));
}

function formatError(err) {
  if (!err) {
    return null;
  }
  if (err.response && err.response.data) {
    return err.response.data;
  }
  return err.message || err.toString();
}

async function warmAgent({ endpointUrl, headers, timeout }) {
  const warmEndpoint = getWarmEndpoint(endpointUrl);
  if (!warmEndpoint) {
    return false;
  }
  const authToken = headers.Authorization || '';
  const cacheKey = `${authToken}:${warmEndpoint}`;
  const cached = warmPromises.get(cacheKey);
  if (cached) {
    return cached;
  }
  const warmPromise = axios
    .post(warmEndpoint, {}, { headers, timeout })
    .then(() => {
      logger.info({ warmEndpoint }, 'Warmed AI agent config');
      return true;
    })
    .catch((err) => {
      logger.error({ err: formatError(err), warmEndpoint }, 'Failed to warm AI agent config');
      throw err;
    })
    .finally(() => {
      warmPromises.delete(cacheKey);
    });

  warmPromises.set(cacheKey, warmPromise);
  return warmPromise;
}

async function forwardToAI({ endpointUrl, apiKey, message, sessionId, openAiKey, memoryEnable = true, contextMemory = '100', ragEnable = true, metadata = {} }) {
  logger.info({
    endpointUrl,
    hasApiKey: !!apiKey,
    message: message?.substring(0, 50) + '...',
    sessionId,
    hasOpenAiKey: !!openAiKey,
    memoryEnable,
    contextMemory,
    ragEnable,
    metadata
  }, 'forwardToAI called with parameters');

  if (!endpointUrl) {
    logger.warn({ endpointUrl }, 'Missing AI endpoint URL, skipping forward');
    return null;
  }
  const headers = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const payload = {
    input: message,
    session_id: sessionId
  };

  logger.info({
    payload,
    endpointUrl,
    headers: { ...headers, Authorization: headers.Authorization ? '[REDACTED]' : undefined }
  }, 'Preparing to send request to AI');

  const sendRequest = async () =>
    axios.post(endpointUrl, payload, {
      headers,
      timeout: config.aiRequestTimeoutMs,
    });

  try {
    const response = await sendRequest();
    logger.info({ endpointUrl, status: response.status }, 'Forwarded message to AI backend');
    return response.data;
  } catch (err) {
    if (err?.response?.status === 400 && shouldWarmForError(err)) {
      try {
        await warmAgent({ endpointUrl, headers, timeout: config.aiRequestTimeoutMs });
      } catch (warmErr) {
        throw warmErr;
      }
      try {
        const retryResponse = await sendRequest();
        logger.info({ endpointUrl, status: retryResponse.status }, 'Forwarded message to AI backend after warm');
        return retryResponse.data;
      } catch (retryErr) {
        logger.error({ err: formatError(retryErr) }, 'Failed to forward message to AI backend after warm');
        throw retryErr;
      }
    }

    logger.error({ err: formatError(err) }, 'Failed to forward message to AI backend');
    throw err;
  }
}

module.exports = { forwardToAI };
