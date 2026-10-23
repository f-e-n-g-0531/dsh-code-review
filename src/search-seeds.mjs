import { retrievalRequest } from './retrieval-loop.mjs';
import { modelWireBudget } from './model-wire-budget.mjs';

const validLine = value => Number.isSafeInteger(value) && value > 0;
const capacity = () => Object.assign(new Error('Optional search seed unavailable'), { code: 'SEARCH_SEED_CAPACITY' });
const inside = (range, line) => validLine(range?.start) && Number.isSafeInteger(range.count) && range.count > 0 && typeof range.text === 'string' && range.start <= line && line < range.start + range.count;

function provided(payload, source, coordinate) {
  if (['old', 'new'].includes(source.side)) {
    const files = [payload.file, ...(Array.isArray(payload.relatedFiles) ? payload.relatedFiles : [])];
    if (files.some(file => file?.path === source.path && file.id === source.fileId && typeof (source.side === 'old' ? file.left?.text : file.right?.text) === 'string')) return true;
    if (payload.file?.path === source.path && payload.file.id === source.fileId && payload.sourceMode === 'change-windows' && Array.isArray(payload.windows)) return payload.windows.some(window => inside(window[source.side], coordinate));
  }
  if (['context', 'context-old'].includes(source.side)) return (payload.context ?? []).some(context => context?.path === source.path && typeof context[source.side === 'context-old' ? 'oldText' : 'text'] === 'string');
  return false;
}

// Host-only follow-up coalescing. Search fragments are navigation, not evidence;
// only a fresh approved read can supply the exact original body. No cache/audit
// or receipts are created here. The caller admits/audits outgoing seeds normally.
export function searchSeeds(scope, request, records, { existing = [], maxReads = 2, maxInputBytes = 98304, buildRequest = values => retrievalRequest(request, scope, values), signal = request?.signal } = {}) {
  if (!Number.isSafeInteger(maxReads) || maxReads < 0 || maxReads > 2 || !Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1 || !Array.isArray(records) || !Array.isArray(existing) || typeof buildRequest !== 'function' || signal !== undefined && !(signal instanceof AbortSignal) || request?.signal !== undefined && !(request.signal instanceof AbortSignal)) throw new Error('Invalid search seed options');
  const check = () => { request?.signal?.throwIfAborted(); signal?.throwIfAborted(); };
  check();
  const seeds = []; let attempts = 0;
  if (!maxReads) return { seeds, attempts };
  if (typeof request?.input !== 'string' || typeof request.instructions !== 'string') throw new Error('Invalid search seed request');
  const payload = JSON.parse(request.input);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.snapshotId !== 'string' || !payload.snapshotId || typeof scope?.transaction !== 'function' || typeof scope.preflight !== 'function' || typeof scope.budget !== 'function') return { seeds, attempts };
  const catalog = scope.catalog(), seen = new Set();
  for (const record of records) {
    check();
    if (record?.request?.kind !== 'search' || record.result?.snapshotId !== payload.snapshotId || !Array.isArray(record.result.matches) || record.result.matches.length > 100) continue;
    for (const match of record.result.matches) {
      check();
      if (attempts >= maxReads) return { seeds, attempts };
      const sources = catalog.filter(source => source.id === match?.sourceId);
      if (sources.length !== 1 || typeof match.hash !== 'string' || !/^[a-f0-9]{64}$/.test(match.hash) || !validLine(match.line)) continue;
      const source = sources[0];
      if (!validLine(source.lineCount) || match.line > source.lineCount || source.hash !== undefined && source.hash !== match.hash || record.request.sourceIds !== undefined && (!Array.isArray(record.request.sourceIds) || !record.request.sourceIds.includes(source.id))) continue;
      const key = JSON.stringify([source.id, match.line]);
      if (seen.has(key)) continue;
      seen.add(key);
      if (provided(payload, source, match.line)) continue;
      if ([...existing, ...seeds].some(item => item?.request?.kind === 'read' && item.result?.snapshotId === payload.snapshotId && item.result.sourceId === source.id && item.result.hash === match.hash && inside(item.result, match.line))) continue;
      const budget = scope.budget();
      // Keep four normal reader calls and 16KiB output headroom; this is not
      // authority expansion or a guarantee that arbitrary final evidence fits.
      if (budget.remainingCalls <= 4 || budget.remainingOutputBytes <= 16 * 1024) return { seeds, attempts };
      const start = Math.max(1, match.line - 3);
      const operation = { kind: 'read', id: source.id, start, count: Math.min(24, source.lineCount - start + 1) };
      attempts++;
      try {
        const item = scope.transaction(() => {
          check(); scope.preflight([operation]);
          const result = scope.read(operation);
          check();
          if (result.snapshotId !== record.result.snapshotId || result.sourceId !== source.id || result.hash !== match.hash || !inside(result, match.line) || result.receiptId !== undefined) throw capacity();
          const next = buildRequest([...existing, ...seeds, { request: operation, result }]);
          check();
          const remaining = scope.budget();
          if (typeof next?.input !== 'string' || typeof next.instructions !== 'string') throw new Error('Invalid search seed request builder');
          if ((request.nativeOutputTools === true ? !modelWireBudget(next, maxInputBytes).fits : Buffer.byteLength(next.input) + Buffer.byteLength(next.instructions) > maxInputBytes) || remaining.remainingCalls < 4 || remaining.remainingOutputBytes < 16 * 1024) throw capacity();
          return { request: operation, result };
        });
        seeds.push(item);
      } catch (error) {
        check();
        if (!['SEARCH_SEED_CAPACITY', 'READER_CALL_BUDGET_EXCEEDED', 'READER_OUTPUT_BUDGET_EXCEEDED'].includes(error?.code)) throw error;
      }
    }
  }
  check();
  return { seeds, attempts };
}
