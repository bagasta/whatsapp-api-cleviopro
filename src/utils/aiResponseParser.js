function extractReplyText(payload) {
  if (!payload) {
    return null;
  }

  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    return trimmed.length ? trimmed : null;
  }

  if (Array.isArray(payload)) {
    // Join strings found in array elements
    const combined = payload
      .map((entry) => extractReplyText(entry))
      .filter((text) => typeof text === 'string' && text.length > 0);

    if (combined.length) {
      return combined.join('\n');
    }
    return null;
  }

  if (typeof payload === 'object') {
    const candidateKeys = ['reply', 'response', 'message', 'answer', 'text', 'content'];
    for (const key of candidateKeys) {
      if (key in payload) {
        const extracted = extractReplyText(payload[key]);
        if (extracted) {
          return extracted;
        }
      }
    }

    if (typeof payload.output === 'object') {
      const extracted = extractReplyText(payload.output);
      if (extracted) {
        return extracted;
      }
    }
  }

  return null;
}

module.exports = {
  extractReplyText,
};
