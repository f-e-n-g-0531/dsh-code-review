// Bound independent work and retrieval round trips; these limits never grant source access.
export function changesConcurrency(value = 2) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 4) throw new Error('Changes concurrency must be an integer from 1 to 4');
  return value;
}
export function retrievalRounds(value = 3) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 50) throw new Error('Retrieval rounds must be an integer from 0 to 50');
  return value;
}

// Verification compares both source sides and supplemental contracts; its bounded
// request-turn allowance is independent, never a new reader/call/time budget.
export function verificationRetrievalRounds(value, primary = 3) {
  primary = retrievalRounds(primary);
  if (value !== undefined) return retrievalRounds(value);
  return primary === 0 ? 0 : Math.max(primary, 6);
}
