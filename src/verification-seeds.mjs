import { createEvidenceReceipts } from './evidence-receipts.mjs';

// Host-only optional prefetch. Only approved catalog identities and actual line
// coordinates select reads; candidate prose/snippets/receipts never become evidence.
const MAX_SEEDS = 8;
const MAX_SEED_BYTES = 16 * 1024;
const optionalFailure = error => ['VERIFICATION_SEED_CAPACITY', 'READER_CALL_BUDGET_EXCEEDED', 'READER_OUTPUT_BUDGET_EXCEEDED'].includes(error?.code);
const capacityError = () => Object.assign(new Error('Optional verification seed capacity exceeded'), { code: 'VERIFICATION_SEED_CAPACITY' });

export function verificationSeeds(candidates, scope, { signal, fits, onReceipt = () => {} }) {
  signal?.throwIfAborted();
  // Without atomic rollback an optional seed could consume the budget and then
  // fail its model-input fit check. Leave those readers on ordinary retrieval.
  if (typeof scope.transaction !== 'function') return [];
  const catalog = scope.catalog();
  const ranges = new Map();
  for (const candidate of candidates) {
    const anchor = candidate?.anchor;
    if (typeof candidate?.fileId !== 'string' || !candidate.fileId || anchor?.kind !== 'line' || !['old', 'new'].includes(anchor.side) || !Number.isSafeInteger(anchor.start) || !Number.isSafeInteger(anchor.end) || anchor.start < 1 || anchor.end < anchor.start) continue;
    const sources = catalog.filter(source => source.fileId === candidate.fileId && source.side === anchor.side);
    if (sources.length !== 1) continue;
    // Never assume that the same line number on the opposite side corresponds
    // to this anchor. The verifier can request that side from the catalog.
    const start = Math.max(1, anchor.start - 4);
    const count = Math.min(200, anchor.end - start + 5);
    const request = { kind: 'read', id: sources[0].id, start, count };
    const key = JSON.stringify(request);
    if (ranges.has(key)) ranges.get(key).references++;
    else if (ranges.size < MAX_SEEDS) ranges.set(key, { request, anchorStart: anchor.start, references: 1 });
  }
  const seeds = [];
  let finalEvidenceBytes = 0;
  for (const { request, anchorStart, references } of ranges.values()) {
    signal?.throwIfAborted();
    const budget = scope.budget?.();
    // At least one exact final validation read per candidate must remain. This
    // reserves no new authority; additional evidence can still exhaust budgets.
    if (budget && budget.remainingOutputBytes <= finalEvidenceBytes) break;
    try {
      const cached = budget?.reusableResults === true && scope.preflight?.([request])?.calls === 0 && scope.canServe?.([request]) === true;
      if (budget && !cached && budget.remainingCalls <= candidates.length) continue;
      // Failed transactions discard their receipt table too, not just the ledger.
      const receipts = createEvidenceReceipts(scope.read, { limit: 1 });
      const item = scope.transaction(() => {
        signal?.throwIfAborted();
        scope.preflight?.([request]);
        const result = receipts.read(request);
        signal?.throwIfAborted();
        if (result.start + result.count <= anchorStart) throw capacityError();
        const proposed = [...seeds, { request, result }];
        const nextBudget = scope.budget?.();
        const reserve = finalEvidenceBytes + Buffer.byteLength(JSON.stringify(result)) * references;
        if (cached) {
          // Validation reads the actual returned count, not the seed's requested
          // EOF-clamped count. These are different exact cache keys. Reserve all
          // final reads explicitly before admitting a zero-call cached seed.
          let calls = 0;
          for (const item of proposed) {
            const validation = { kind: 'read', id: item.result.sourceId, start: item.result.start, count: item.result.count };
            const cost = scope.preflight([validation]);
            if (!Number.isSafeInteger(cost?.calls) || cost.calls < 0) throw capacityError();
            const matching = [...ranges.values()].find(range => JSON.stringify(range.request) === JSON.stringify(item.request));
            calls += cost.calls * (matching?.references ?? 1);
          }
          if (nextBudget && calls > nextBudget.remainingCalls) throw capacityError();
        }
        if (Buffer.byteLength(JSON.stringify(proposed)) > MAX_SEED_BYTES || !fits(proposed) || (nextBudget && nextBudget.remainingOutputBytes < reserve)) throw capacityError();
        signal?.throwIfAborted();
        return { request, result };
      });
      // Publish only after the approved reader has committed the transaction.
      onReceipt(item.result.receiptId, receipts.resolve);
      seeds.push(item);
      finalEvidenceBytes += Buffer.byteLength(JSON.stringify(item.result)) * references;
    } catch (error) {
      signal?.throwIfAborted();
      if (optionalFailure(error) || error?.message === 'Line range outside source') continue;
      throw error;
    }
  }
  return seeds;
}
