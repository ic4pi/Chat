// ... existing imports ...

/**
 * Updated budgeter that respects the specific model's context window
 * rather than a global constant.
 */
function budgetMessages(systemPrompt, messages, resolutionLimit) {
  const safeLimit = resolutionLimit * 0.9; // 10% safety buffer
  
  let system = truncateToTokens(systemPrompt || '', MAX_SYSTEM_TOKENS);

  const mutMessages = messages.map((m) => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : contentToString(m.content),
  }));
  
  let histTokens = mutMessages.reduce((n, m) => n + estimateTokens(m.content), 0);
  
  while (mutMessages.length > 1 && histTokens > MAX_HISTORY_TOKENS) {
    const removed = mutMessages.shift();
    histTokens -= estimateTokens(removed.content);
  }

  for (const m of mutMessages) {
    if (estimateTokens(m.content) > 8000) {
       m.content = truncateToTokens(m.content, 8000);
    }
  }

  let total = estimateTokens(system) + mutMessages.reduce((n, m) => n + estimateTokens(m.content), 0);
  
  if (total > safeLimit) {
    system = truncateToTokens(system, Math.max(4000, safeLimit - histTokens - 1000));
    total = estimateTokens(system) + mutMessages.reduce((n, m) => n + estimateTokens(m.content), 0);
  }

  return { system, messages: mutMessages, tokens: total };
}

// Then in handler:
// const budgeted = budgetMessages(systemPrompt, messages, resolved.contextWindow);
