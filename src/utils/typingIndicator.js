async function showTypingWhile(promise, chat) {
  if (!chat || typeof chat.sendStateTyping !== 'function') {
    return promise;
  }

  let cancelled = false;

  const keepTyping = async () => {
    while (!cancelled) {
      try {
        await chat.sendStateTyping();
      } catch (err) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  };

  const typingLoop = keepTyping();

  try {
    const result = await promise;
    cancelled = true;
    await typingLoop;
    try {
      await chat.clearState();
    } catch (err) {
      // ignore cleanup errors
    }
    return result;
  } catch (err) {
    cancelled = true;
    await typingLoop;
    try {
      await chat.clearState();
    } catch (clearErr) {
      // ignore cleanup errors
    }
    throw err;
  }
}

module.exports = { showTypingWhile };
