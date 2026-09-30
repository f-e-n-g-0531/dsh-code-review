import { retrievalRequest } from './retrieval-loop.mjs';

// Count the actual initial envelope, including instructions and retrieval catalog.
// This is not a token/price estimate and does not reserve later retrieval rounds.
export function initialInputBudget(request, scope, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid input budget');
  const actual = scope ? retrievalRequest(request, scope) : request;
  const bytes = Buffer.byteLength(actual.input) + Buffer.byteLength(actual.instructions);
  return { bytes, maxBytes, fits: bytes <= maxBytes };
}
