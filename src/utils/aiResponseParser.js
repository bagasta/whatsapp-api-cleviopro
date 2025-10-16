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
    // Langchain API returns response in 'response' field
    if (payload.response && typeof payload.response !== 'object') {
      const extracted = extractReplyText(payload.response);
      if (extracted) {
        return extracted;
      }
    }

    // Check other possible fields in order of preference
    const candidateKeys = ['response', 'output', 'reply', 'message', 'answer', 'text', 'content'];
    for (const key of candidateKeys) {
      if (key in payload) {
        const extracted = extractReplyText(payload[key]);
        if (extracted) {
          return extracted;
        }
      }
    }
  }

  return null;
}

module.exports = {
  extractReplyText,
};
