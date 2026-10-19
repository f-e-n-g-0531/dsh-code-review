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

function validQuery(query, limit) {
  return typeof query === 'string' && query.length > 0 && query.length <= 256 && !/[\r\n]/.test(query) && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100;
}

function budgetError(kind) {
  const error = new Error('Reader ' + kind + ' budget exceeded');
  error.code = kind === 'call' ? 'READER_CALL_BUDGET_EXCEEDED' : 'READER_OUTPUT_BUDGET_EXCEEDED';
  return error;
}

// This capability reads only caller-approved text entries, never the filesystem.
export function createSnapshotReader(snapshotId, entries, { maxBytes = 4 * 1024 * 1024, maxCalls = 50, maxOutputBytes = 256 * 1024, signal } = {}) {
  if (typeof snapshotId !== 'string' || !snapshotId || snapshotId.length > 200) throw new Error('Invalid snapshot identity');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) throw new Error('Invalid reader budget');
  if (!Array.isArray(entries) || entries.length > 500) throw new Error('Invalid reader entries');
  for (const [value, cap] of [[maxCalls, 1000], [maxOutputBytes, 4 * 1024 * 1024]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > cap) throw new Error('Invalid reader budget');
  }
  signal?.throwIfAborted();

  let calls = 0, outputBytes = 0, inTransaction = false;
  const begin = () => {
    signal?.throwIfAborted();
    if (calls >= maxCalls) throw budgetError('call');
    calls++;
  };
  const resultSize = result => {
    const size = Buffer.byteLength(JSON.stringify(result));
    if (size > 64 * 1024) throw budgetError('output');
    return size;
  };
  const finish = result => {
    signal?.throwIfAborted();
    const size = resultSize(result);
    if (outputBytes + size > maxOutputBytes) throw budgetError('output');
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

  const find = ({ query, limit = 20 }) => {
    if (!validQuery(query, limit)) throw new Error('Invalid find request');
    const matches = [];
    for (const [id, source] of sources) {
      signal?.throwIfAborted();
      if (typeof source.path !== 'string' || !source.path.includes(query)) continue;
      if (matches.length === limit) return { snapshotId, matches, truncated: true };
      matches.push({ sourceId: id, path: source.path, side: source.side, hash: source.hash });
    }
    return { snapshotId, matches, truncated: false };
  };
  const search = ({ query, limit = 20, sourceIds }) => {
    if (!validQuery(query, limit)) throw new Error('Invalid search request');
    if (sourceIds !== undefined && (!Array.isArray(sourceIds) || !sourceIds.length || sourceIds.length > 20 || new Set(sourceIds).size !== sourceIds.length || sourceIds.some(id => !sources.has(id)))) throw new Error('Invalid search source filter');
    const selected = sourceIds === undefined ? null : new Set(sourceIds);
    const matches = [];
    for (const [id, source] of sources) {
      if (selected && !selected.has(id)) continue;
      signal?.throwIfAborted();
      for (const range of lineRanges(source.text)) {
        if (!source.text.slice(range.start, range.end).includes(query)) continue;
        if (matches.length === limit) return { snapshotId, matches, truncated: true };
        matches.push({ sourceId: id, hash: source.hash, line: range.line });
      }
    }
    return { snapshotId, matches, truncated: false };
  };
  const read = ({ id, start, count }) => {
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
    if (Buffer.byteLength(text) > 64 * 1024) throw budgetError('output');
    return { snapshotId, sourceId: id, hash: source.hash, start, count: selectedCount, text, endOfSource: endOffset === source.text.length };
  };

  return Object.freeze({
    usage: () => ({ calls, outputBytes }),
    budget: () => ({ maxCalls, maxOutputBytes, remainingCalls: maxCalls - calls, remainingOutputBytes: maxOutputBytes - outputBytes, maxResultBytes: 64 * 1024 }),
    // A synchronous host-only batch commits its ledger only as a whole. This
    // also covers decorated response bytes that preflight cannot predict.
    // Callers must not publish results/audit records before this returns.
    transaction(execute) {
      signal?.throwIfAborted();
      if (inTransaction || typeof execute !== 'function') throw new Error('Invalid reader transaction');
      const previousCalls = calls, previousBytes = outputBytes;
      inTransaction = true;
      try {
        const result = execute();
        if (result && typeof result.then === 'function') throw new Error('Invalid asynchronous reader transaction');
        signal?.throwIfAborted();
        return result;
      } catch (error) {
        calls = previousCalls; outputBytes = previousBytes;
        throw error;
      } finally { inTransaction = false; }
    },
    // Host-only dry run. Validate ALL ranges and sources before charging anything.
    // No evidence or receipts escape this preflight. Decorated reads are still
    // measured by finish; this never reserves or increases the shared budget.
    preflight(requests) {
      signal?.throwIfAborted();
      if (!Array.isArray(requests) || !requests.length || requests.length > 8) throw new Error('Invalid retrieval batch');
      const results = requests.map(request => {
        if (request?.kind === 'read') return read(request);
        if (request?.kind === 'find') return find(request);
        if (request?.kind === 'search') return search(request);
        throw new Error('Unsupported retrieval operation');
      });
      if (calls + requests.length > maxCalls) throw budgetError('call');
      const size = results.reduce((sum, result) => sum + resultSize(result), 0);
      if (outputBytes + size > maxOutputBytes) throw budgetError('output');
    },
    find(request) { begin(); return finish(find(request)); },
    search(request) { begin(); return finish(search(request)); },
    // decorate is a host-only callback; model requests never supply it.
    read(request, decorate = value => value) { begin(); return finish(decorate(read(request))); },
  });
}
