// Bound independent work and retrieval round trips; these limits never grant source access.
export function changesConcurrency(value = 2) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 4) throw new Error('Changes concurrency must be an integer from 1 to 4');
  return value;
}
export function retrievalRounds(value = 3) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 50) throw new Error('Retrieval rounds must be an integer from 0 to 50');
  return value;
}
