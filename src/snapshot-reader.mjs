import { createHash } from 'node:crypto';

// This capability reads only caller-approved text entries, never the filesystem.
export function createSnapshotReader(snapshotId, entries, { maxBytes = 4 * 1024 * 1024 } = {}) {
  if (typeof snapshotId !== 'string' || !snapshotId || snapshotId.length > 200) throw new Error('Invalid snapshot identity');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) throw new Error('Invalid reader budget');
  if (!Array.isArray(entries) || entries.length > 500) throw new Error('Invalid reader entries');
  const sources = new Map();
  let bytes = 0;
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || entry.id.length > 200 || sources.has(entry.id) || typeof entry.text !== 'string') throw new Error('Invalid reader entry');
    bytes += Buffer.byteLength(entry.text);
    if (bytes > maxBytes) throw new Error('Reader content budget exceeded');
    sources.set(entry.id, { text: entry.text, hash: createHash('sha256').update(entry.text).digest('hex') });
  }
  return Object.freeze({
    read({ id, start, count }) {
      if (!sources.has(id)) throw new Error('Source not authorized');
      if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(count) || count < 1 || count > 200) throw new Error('Invalid line range');
      const source = sources.get(id);
      const lines = source.text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
      if (start > lines.length) throw new Error('Line range outside source');
      const selected = lines.slice(start - 1, start - 1 + count);
      const text = selected.join('');
      if (Buffer.byteLength(text) > 64 * 1024) throw new Error('Reader output budget exceeded');
      return { snapshotId, sourceId: id, hash: source.hash, start, count: selected.length, text, endOfSource: start - 1 + selected.length === lines.length };
    },
  });
}
