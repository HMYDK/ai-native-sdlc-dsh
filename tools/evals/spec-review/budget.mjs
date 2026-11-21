/** Observed-token limits apply to further model work, not an already-paid terminal submission. */
export function cancelAfterResponse(usedTokens, tokenLimit, content) {
  if (usedTokens <= tokenLimit) return false;
  const calls = content.filter(block => block.type === 'tool-call');
  return calls.length !== 1 || calls[0].name !== 'structured_output';
}

/** Even a malformed/rejected terminal submission cannot buy another model step over budget. */
export function cancelBeforeStep(usedTokens, tokenLimit, steps, stepLimit) {
  return usedTokens > tokenLimit || steps > stepLimit;
}
