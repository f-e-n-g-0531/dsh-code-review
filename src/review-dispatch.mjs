const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);

// Pure dispatch metadata. A successful plan is not model capacity discovery or
// coverage. Callers must freeze this decision into preview/execute identity.
export function resolveReviewDispatch(options = {}) {
  if (!plain(options)) fail('INVALID_REVIEW_DISPATCH', 'Invalid review dispatch options');
  const { requested = 'auto', mode = 'changes', rounds = 1, resume = false, sourceBytes, wholePlan, hostAvailable = false, concurrency = 2 } = options;
  if (!plain(options) || Object.keys(options).some(key => !['requested', 'mode', 'rounds', 'resume', 'sourceBytes', 'wholePlan', 'hostAvailable', 'concurrency'].includes(key))) fail('INVALID_REVIEW_DISPATCH', 'Unknown review dispatch option');
  if (!['auto', 'staged', 'whole-scope'].includes(requested) || !['changes', 'project'].includes(mode) || !Number.isSafeInteger(rounds) || rounds < 1 || typeof resume !== 'boolean' || typeof hostAvailable !== 'boolean' || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4 || sourceBytes !== undefined && (!Number.isSafeInteger(sourceBytes) || sourceBytes < 0)) fail('INVALID_REVIEW_DISPATCH', 'Invalid review dispatch policy');
  const result = (effectiveStrategy, reason, summary = {}) => Object.freeze({ requested, effectiveStrategy, reason, childMode: effectiveStrategy === 'staged' ? 'none' : 'direct', eligibleCount: null, oversizedCount: null, plannedChildCount: 0, concurrency: 1, ...(sourceBytes === undefined ? {} : { sourceBytes }), ...summary });
  if (requested === 'staged') return result('staged', 'explicit-staged');
  const unsupported = mode === 'project' ? 'project-requires-staged' : resume ? 'resume-requires-staged' : rounds !== 1 ? 'multiple-rounds-require-staged' : null;
  if (unsupported) {
    if (requested === 'whole-scope') fail('WHOLE_SCOPE_UNSUPPORTED', unsupported);
    return result('staged', unsupported);
  }
  if (!plain(wholePlan) || wholePlan.wholeScope !== true || !Array.isArray(wholePlan.batches) || !Array.isArray(wholePlan.oversized) || wholePlan.batches.length > 200 || wholePlan.oversized.length > 200) fail('INVALID_WHOLE_SCOPE_PLAN', 'A complete whole-scope capacity plan is required');
  const members = new Set();
  const add = id => { if (typeof id !== 'string' || !id || members.has(id)) fail('INVALID_WHOLE_SCOPE_PLAN', 'Invalid or duplicate planned member'); members.add(id); };
  for (const batch of wholePlan.batches) {
    if (!plain(batch) || !Array.isArray(batch.fileIds) || !batch.fileIds.length) fail('INVALID_WHOLE_SCOPE_PLAN', 'Invalid whole-scope batch');
    batch.fileIds.forEach(add);
  }
  for (const row of wholePlan.oversized) {
    if (!plain(row)) fail('INVALID_WHOLE_SCOPE_PLAN', 'Invalid oversized member');
    add(row.fileId);
  }
  if (members.size > 200) fail('INVALID_WHOLE_SCOPE_PLAN', 'Whole-scope member limit exceeded');
  const summary = { eligibleCount: members.size, oversizedCount: wholePlan.oversized.length };
  if (requested === 'auto' && wholePlan.oversized.length) return result('staged', 'complete-files-exceed-capacity', summary);
  const multiple = wholePlan.batches.length > 1;
  if (multiple && !hostAvailable) fail('REVIEW_SUBAGENTS_UNAVAILABLE', 'Multiple whole-scope batches require restricted host children; no hidden fallback');
  return result('whole-scope', requested === 'whole-scope' ? 'explicit-whole-scope' : members.size === 0 ? 'no-eligible-files' : multiple ? 'complete-files-fit-multiple-batches' : 'complete-files-fit-one-batch', {
    ...summary, childMode: multiple ? 'host-subagents' : 'direct', plannedChildCount: multiple ? wholePlan.batches.length : 0, concurrency: multiple ? Math.min(concurrency, wholePlan.batches.length) : 1,
  });
}
