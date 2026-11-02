import { retrievalRequest } from './retrieval-loop.mjs';
import { modelWireBudget, nativeWireEnabled } from './model-wire-budget.mjs';

const positive = value => Number.isSafeInteger(value) && value > 0;
const contains = (outer, inner) => positive(outer?.start) && positive(outer?.count) && outer.start <= inner.start && outer.start + outer.count >= inner.start + inner.count;
const capacity = () => Object.assign(new Error('Optional evidence context unavailable'), { code: 'EVIDENCE_CONTEXT_CAPACITY' });
const optional = error => ['EVIDENCE_CONTEXT_CAPACITY', 'READER_CALL_BUDGET_EXCEEDED', 'READER_OUTPUT_BUDGET_EXCEEDED'].includes(error?.code);

function supplied(payload, source, range) {
  if (source.side === 'context' || source.side === 'context-old') return (Array.isArray(payload.context) ? payload.context : []).some(item => item?.path === source.path && typeof item[source.side === 'context' ? 'text' : 'oldText'] === 'string');
  if (!['old', 'new'].includes(source.side)) return false;
  const files = [payload.file, ...(Array.isArray(payload.relatedFiles) ? payload.relatedFiles : []), ...(Array.isArray(payload.reviews) ? payload.reviews.flatMap(review => [review.file, ...(Array.isArray(review.relatedFiles) ? review.relatedFiles : [])]) : [])];
  if (files.some(file => file?.id === source.fileId && file.path === source.path && typeof (source.side === 'old' ? file.left?.text : file.right?.text) === 'string')) return true;
  return payload.file?.id === source.fileId && payload.file.path === source.path && payload.sourceMode === 'change-windows' && (payload.windows ?? []).some(window => typeof window?.[source.side]?.text === 'string' && contains(window[source.side], range));
}

// A review-lifetime navigation index, NOT evidence, authority, or a receipt store.
// remember() must be called only for reads admitted to an actual model input.
// seed() never audits or remembers its own results; the sender does that after
// its normal fit/beforeCall/cancellation checks, just like ordinary retrieval.
export function createEvidenceContext(snapshotId, { maxEntries = 128 } = {}) {
  if (typeof snapshotId !== 'string' || !snapshotId || snapshotId.length > 500 || !positive(maxEntries) || maxEntries > 512) throw new Error('Invalid evidence context options');
  const entries = new Map();
  return Object.freeze({
    size: () => entries.size,
    remember(records) {
      if (!Array.isArray(records) || records.length > 256) throw new Error('Invalid evidence context records');
      for (const record of records) {
        if (record?.kind !== 'read' || record.snapshotId !== snapshotId || record.omitted === true || typeof record.sourceId !== 'string' || !record.sourceId || record.sourceId.length > 200 || typeof record.hash !== 'string' || !/^[a-f0-9]{64}$/.test(record.hash) || !positive(record.start) || !positive(record.count) || record.count > 200 || !Number.isSafeInteger(record.start + record.count)) continue;
        const item = { sourceId: record.sourceId, hash: record.hash, start: record.start, count: record.count };
        const key = JSON.stringify(item);
        if (entries.has(key)) continue;
        if (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
        entries.set(key, item);
      }
    },
    seed(scope, request, { sourceIds = [], ranges = [], existing = [], maxReads = 4, maxLines = 80, maxBytes = 16384, maxInputBytes = 98304, reserveCalls = 2, reserveBytes = 4096, signal = request?.signal, buildRequest = records => retrievalRequest(request, scope, records) } = {}) {
      if (!Array.isArray(sourceIds) || sourceIds.length > 200 || sourceIds.some(id => typeof id !== 'string' || !id || id.length > 200) || !Array.isArray(ranges) || ranges.length > 200 || ranges.some(range => typeof range?.sourceId !== 'string' || !positive(range.start) || !positive(range.count) || !Number.isSafeInteger(range.start + range.count)) || !Array.isArray(existing) || existing.length > 50 || !Number.isSafeInteger(maxReads) || maxReads < 0 || maxReads > 8 || !positive(maxLines) || maxLines > 200 || !positive(maxBytes) || maxBytes > 65536 || !positive(maxInputBytes) || !Number.isSafeInteger(reserveCalls) || reserveCalls < 0 || reserveCalls > 100 || !Number.isSafeInteger(reserveBytes) || reserveBytes < 0 || reserveBytes > 1048576 || typeof buildRequest !== 'function' || signal !== undefined && !(signal instanceof AbortSignal) || request?.signal !== undefined && !(request.signal instanceof AbortSignal)) throw new Error('Invalid evidence context seed options');
      const check = () => { request?.signal?.throwIfAborted(); signal?.throwIfAborted(); };
      check();
      const seeds = [];
      if (!maxReads || !entries.size || !sourceIds.length && !ranges.length) return seeds;
      if (typeof request?.input !== 'string' || typeof request.instructions !== 'string') throw new Error('Invalid evidence context request');
      const payload = JSON.parse(request.input);
      if (payload?.snapshotId !== snapshotId || typeof scope?.transaction !== 'function' || typeof scope.preflight !== 'function' || typeof scope.catalog !== 'function' || typeof scope.read !== 'function' || typeof scope.budget !== 'function') return seeds;
      const catalog = scope.catalog(), selected = new Set(sourceIds);
      const attempted = new Set();
      let attempts = 0;
      try {
        return scope.transaction(() => {
          for (const entry of entries.values()) {
            check();
            if (attempts >= maxReads) break;
            const sources = catalog.filter(source => source.id === entry.sourceId);
            if (sources.length !== 1) continue;
            const source = sources[0];
            if (!positive(source.lineCount) || entry.start > source.lineCount || source.hash !== undefined && source.hash !== entry.hash) continue;
            const overlap = ranges.find(range => range.sourceId === entry.sourceId && range.start < entry.start + entry.count && entry.start < range.start + range.count);
            if (!selected.has(entry.sourceId) && !overlap) continue;
            const start = overlap ? Math.max(entry.start, overlap.start) : entry.start;
            const count = Math.min(maxLines, entry.start + entry.count - start, source.lineCount - start + 1, overlap ? overlap.start + overlap.count - start : Infinity);
            const operation = { kind: 'read', id: source.id, start, count };
            const key = JSON.stringify(operation);
            if (attempted.has(key) || supplied(payload, source, operation)) continue;
            if ([...existing, ...seeds].some(item => item?.request?.kind === 'read' && item.result?.snapshotId === snapshotId && item.result.sourceId === source.id && item.result.hash === entry.hash && typeof item.result.text === 'string' && contains(item.result, operation))) continue;
            attempted.add(key); attempts++;
            check();
            const budget = scope.budget(), cost = scope.preflight([operation]);
            const cached = budget.reusableResults === true && cost?.calls === 0;
            if ((!cached && budget.remainingCalls <= reserveCalls) || budget.remainingOutputBytes <= reserveBytes) throw capacity();
            const result = scope.read(operation);
            check();
            if (result.snapshotId !== snapshotId || result.sourceId !== source.id || result.hash !== entry.hash || result.start !== start || result.count !== count || typeof result.text !== 'string' || result.receiptId !== undefined || result.omitted === true) throw capacity();
            const proposed = [...seeds, { request: operation, result }];
            if (Buffer.byteLength(JSON.stringify(proposed)) > maxBytes) throw capacity();
            const next = buildRequest([...existing, ...proposed]);
            if (typeof next?.input !== 'string' || typeof next.instructions !== 'string') throw new Error('Invalid evidence context request builder');
            const fits = nativeWireEnabled(request, scope) ? modelWireBudget({ ...next, nativeOutputTools: true }, maxInputBytes).fits : Buffer.byteLength(next.input) + Buffer.byteLength(next.instructions) <= maxInputBytes;
            check();
            const remaining = scope.budget();
            if (!fits || (!cached && remaining.remainingCalls < reserveCalls) || remaining.remainingOutputBytes < reserveBytes) throw capacity();
            seeds.push({ request: operation, result });
          }
          check();
          return seeds;
        });
      } catch (error) {
        check();
        if (!optional(error)) throw error;
        // One rejected item abandons the entire optional batch: previously read
        // siblings must not consume bytes/calls when no seed array is returned.
        return [];
      }
    },
  });
}
