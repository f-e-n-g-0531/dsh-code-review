import { randomUUID } from 'node:crypto';

// Per-verification capability table. Never persisted or shared across reviews.
// Resolution only supplies exact data; the caller must still validate against
// the approved reader (and consume its shared budget).
export function createEvidenceReceipts(read, { limit = 50 } = {}) {
  if (typeof read !== 'function' || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid evidence receipt configuration');
  const entries = new Map();
  const keys = ['snapshotId', 'sourceId', 'hash', 'start', 'count', 'text'];
  return Object.freeze({
    read(request) {
      if (entries.size >= limit) throw new Error('Evidence receipt limit exceeded');
      const receiptId = randomUUID();
      // The approved reader measures the decorated response before returning.
      // Failed reads must not leave a resolvable receipt behind.
      const result = read(request, value => ({ ...value, receiptId }));
      if (!result.text || result.count < 1) return result;
      if (result.receiptId !== receiptId) throw new Error('Reader does not support budgeted evidence receipts');
      const reference = Object.freeze(Object.fromEntries(keys.map(k => [k, result[k]])));
      entries.set(receiptId, reference);
      return { ...result, receiptId };
    },
    resolve(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'receiptId')) return value;
      if (Object.keys(value).length !== 1 || typeof value.receiptId !== 'string' || !entries.has(value.receiptId)) throw new Error('Invalid evidence receipt');
      return { ...entries.get(value.receiptId) };
    },
  });
}
