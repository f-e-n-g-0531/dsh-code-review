import { createHash } from 'node:crypto';

function* lineRanges(text) {
  let start = 0, line = 1;
  while (start < text.length) {
    const newline = text.indexOf('\n', start);
    const end = newline < 0 ? text.length : newline + 1;
    yield { start, end, line: line++ };
    start = end;
  }
}

// This capability reads only caller-approved text entries, never the filesystem.
export function createSnapshotReader(snapshotId, entries, { maxBytes = 4 * 1024 * 1024, maxCalls = 50, maxOutputBytes = 256 * 1024, signal } = {}) {
  if (typeof snapshotId !== 'string' || !snapshotId || snapshotId.length > 200) throw new Error('Invalid snapshot identity');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) throw new Error('Invalid reader budget');
  if (!Array.isArray(entries) || entries.length > 500) throw new Error('Invalid reader entries');
  for (const [value, cap] of [[maxCalls, 1000], [maxOutputBytes, 4 * 1024 * 1024]]) if (!Number.isSafeInteger(value) || value < 1 || value > cap) throw new Error('Invalid reader budget');
  signal?.throwIfAborted();
  let calls = 0, outputBytes = 0;
  const begin = () => { signal?.throwIfAborted(); if (calls >= maxCalls) throw new Error('Reader call budget exceeded'); calls++; };
  const finish = result => {
    signal?.throwIfAborted();
    const size = Buffer.byteLength(JSON.stringify(result));
    if (size > 64 * 1024 || outputBytes + size > maxOutputBytes) throw new Error('Reader output budget exceeded');
    outputBytes += size;
    return result;
  };
  const sources = new Map();
  let bytes = 0;
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || entry.id.length > 200 || sources.has(entry.id) || typeof entry.text !== 'string') throw new Error('Invalid reader entry');
    bytes += Buffer.byteLength(entry.text);
    if (bytes > maxBytes) throw new Error('Reader content budget exceeded');
    sources.set(entry.id, { path: entry.path, side: entry.side, text: entry.text, hash: createHash('sha256').update(entry.text).digest('hex') });
  }
  return Object.freeze({
    usage: () => ({ calls, outputBytes }),
    find({ query, limit = 20 }) {
      begin();
      if (typeof query !== 'string' || !query || query.length > 256 || /[\r\n]/.test(query) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid find request');
      const matches = [];
      for (const [id, source] of sources) {
        signal?.throwIfAborted();
        if (typeof source.path !== 'string' || !source.path.includes(query)) continue;
        if (matches.length === limit) return finish({ snapshotId, matches, truncated: true });
        matches.push({ sourceId: id, path: source.path, side: source.side, hash: source.hash });
      }
      return finish({ snapshotId, matches, truncated: false });
    },
    search({ query, limit = 20, sourceIds }) {
      begin();
      if (typeof query !== 'string' || !query || query.length > 256 || /[\r\n]/.test(query) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid search request');
      if (sourceIds !== undefined && (!Array.isArray(sourceIds) || !sourceIds.length || sourceIds.length > 20 || new Set(sourceIds).size !== sourceIds.length || sourceIds.some(id=>!sources.has(id)))) throw new Error('Invalid search source filter');
      const selected = sourceIds === undefined ? null : new Set(sourceIds);
      const matches = [];
      for (const [id, source] of sources) {
        if (selected && !selected.has(id)) continue;
        signal?.throwIfAborted();
        for (const range of lineRanges(source.text)) {
          if (!source.text.slice(range.start, range.end).includes(query)) continue;
          if (matches.length === limit) return finish({ snapshotId, matches, truncated: true });
          matches.push({ sourceId: id, hash: source.hash, line: range.line });
        }
      }
      return finish({ snapshotId, matches, truncated: false });
    },
    // decorate is a host-only callback; model requests never supply it.
    read({ id, start, count }, decorate = value => value) {
      begin();
      if (!sources.has(id)) throw new Error('Source not authorized');
      if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(count) || count < 1 || count > 200) throw new Error('Invalid line range');
      const source = sources.get(id);
      let beginOffset = -1, endOffset = 0, selectedCount = 0;
      for (const range of lineRanges(source.text)) {
        if (range.line < start) continue;
        if (beginOffset < 0) beginOffset = range.start;
        endOffset = range.end;
        selectedCount++;
        if (selectedCount === count) break;
      }
      if (beginOffset < 0) throw new Error('Line range outside source');
      const text = source.text.slice(beginOffset, endOffset);
      if (Buffer.byteLength(text) > 64 * 1024) throw new Error('Reader output budget exceeded');
      return finish(decorate({ snapshotId, sourceId: id, hash: source.hash, start, count: selectedCount, text, endOfSource: endOffset === source.text.length }));
    },
  });
}
