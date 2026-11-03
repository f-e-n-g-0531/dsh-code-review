import { createEvidenceReceipts } from './evidence-receipts.mjs';
import { migrationVerificationPlans } from './migration-regression.mjs';

const size = value => Buffer.byteLength(JSON.stringify(value));
const key = request => JSON.stringify(request);
const capacity = reason => Object.assign(new Error('Optional migration seed capacity exceeded'), { code: 'VERIFICATION_SEED_CAPACITY', reason });
const optional = error => ['VERIFICATION_SEED_CAPACITY', 'READER_CALL_BUDGET_EXCEEDED', 'READER_OUTPUT_BUDGET_EXCEEDED'].includes(error?.code) || error?.message === 'Line range outside source';

// No external plans are accepted: only the compiled context selects candidates.
export function migrationVerificationSeeds(context, scope, { signal, fits, onReceipt = () => {}, onMigrationSeeds = () => {} }) {
  signal?.throwIfAborted();
  const plans = migrationVerificationPlans(context), catalog = scope.catalog();
  const seeds = [], selected = new Map(), assignments = new Map();
  const ordinary = candidate => {
    const anchor = candidate.anchor;
    if (anchor?.kind !== 'line' || !['old', 'new'].includes(anchor.side) || !Number.isSafeInteger(anchor.start) || !Number.isSafeInteger(anchor.end) || anchor.start < 1 || anchor.end < anchor.start) return [];
    const sources = catalog.filter(source => source.fileId === candidate.fileId && source.side === anchor.side);
    if (sources.length !== 1) return [];
    const start = Math.max(1, anchor.start - 4);
    return [{ kind: 'read', id: sources[0].id, start, count: Math.min(200, anchor.end - start + 5) }];
  };
  const notify = (plan, status, reason) => {
    // Deliberately reconstruct a source-free allowlist, never spread a plan.
    onMigrationSeeds({ candidateId: plan.candidateId, ...(plan.contractId ? { contractId: plan.contractId } : {}), kind: plan.kind ?? 'migration', status, reason, rolesCount: plan.rolesCount ?? 0 });
    signal?.throwIfAborted();
  };
  const admit = (plan, requests, complete) => {
    if (!requests.length || typeof scope.transaction !== 'function' || typeof scope.preflight !== 'function') throw capacity('TRANSACTION_UNAVAILABLE');
    const fresh = requests.filter(request => !selected.has(key(request)));
    if (seeds.length + fresh.length > 8) throw capacity('SEED_LIMIT');
    const receipts = createEvidenceReceipts(scope.read, { limit: Math.max(1, fresh.length) });
    const items = scope.transaction(() => {
      signal?.throwIfAborted();
      if (fresh.length) scope.preflight(fresh);
      const items = fresh.map(request => {
        const result = receipts.read(request);
        signal?.throwIfAborted();
        if (result.sourceId !== request.id || result.start !== request.start || !result.text || (complete ? result.count !== request.count : result.start + result.count <= plan.candidate.anchor.start)) throw capacity('INCOMPLETE_READ');
        return { request, result };
      });
      const proposed = [...seeds, ...items], lookup = new Map(proposed.map(item => [key(item.request), item]));
      const nextAssignments = new Map(assignments).set(plan.candidateId, requests.map(key));
      // Reserve repeated candidates now, not after the first set has consumed
      // headroom. Exact shared plans need no additional materialization call.
      for (const other of plans) {
        // A prior fallback does not limit what this candidate may reference from
        // the globally visible role set admitted by a later candidate. Upgrade its
        // reserve whenever its complete plan becomes available.
        const completeReferences = other.requests?.map(key);
        const references = completeReferences?.every(reference => lookup.has(reference)) ? completeReferences : nextAssignments.get(other.candidateId) ?? ordinary(other.candidate).map(key);
        if (references.length && references.every(reference => lookup.has(reference))) nextAssignments.set(other.candidateId, references);
      }
      let calls = plans.length - nextAssignments.size, bytes = 0;
      // Every candidate reference is a final delivery, even for shared cached
      // results. EOF-clamped validation counts have their own exact cache key.
      for (const references of nextAssignments.values()) for (const reference of references) {
        const result = lookup.get(reference).result;
        const cost = scope.preflight([{ kind: 'read', id: result.sourceId, start: result.start, count: result.count }]);
        if (!Number.isSafeInteger(cost?.calls) || cost.calls < 0) throw capacity('FINAL_RESERVE');
        calls += cost.calls;
        bytes += size(result);
      }
      const budget = scope.budget?.();
      if (budget && (budget.remainingCalls < calls || budget.remainingOutputBytes < bytes)) throw capacity('FINAL_RESERVE');
      if (size(proposed) > 16 * 1024 || !fits(proposed)) throw capacity('INPUT_CAPACITY');
      signal?.throwIfAborted();
      return items;
    });
    for (const item of items) {
      selected.set(key(item.request), item);
      seeds.push(item);
      onReceipt(item.result.receiptId, receipts.resolve);
    }
    assignments.set(plan.candidateId, requests.map(key));
  };
  for (const plan of plans) {
    signal?.throwIfAborted();
    let reason = plan.reason;
    if (plan.requests) {
      let accepted = false;
      try { admit(plan, plan.requests, true); accepted = true; }
      catch (error) { signal?.throwIfAborted(); if (!optional(error)) throw error; reason = error.reason ?? error.code ?? 'INCOMPLETE_READ'; }
      if (accepted) { notify(plan, 'accepted', 'COMPLETE_ROLE_SET'); continue; }
    }
    notify(plan, 'fallback', reason ?? 'NO_MATCHING_CONTRACT');
    try { admit(plan, ordinary(plan.candidate), false); }
    catch (error) { signal?.throwIfAborted(); if (!optional(error)) throw error; }
  }
  return seeds;
}
