import { preparePrimaryInput } from './primary-input.mjs';

// Metadata only. No retained payload, file reads, model calls, or approval grants.
export function buildCoveragePlan(input, options) {
  if (!input || typeof input.id !== 'string' || !input.id || !Array.isArray(input.files) || input.files.length > 200) throw new Error('Invalid planning snapshot');
  if (!options || typeof options.instructions !== 'string' || !Number.isSafeInteger(options.maxInputBytes) || options.maxInputBytes < 1) throw new Error('Invalid planning budget');
  const ids = new Set(), paths = new Set();
  for (const file of input.files) {
    if (!file || typeof file.id !== 'string' || !file.id || ids.has(file.id) || typeof file.path !== 'string' || !file.path || paths.has(file.path) || !['reviewable','excluded','blocked'].includes(file.eligibility)) throw new Error('Invalid planning file');
    ids.add(file.id); paths.add(file.path);
  }
  const items = [...input.files].sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map(file => {
    options.signal?.throwIfAborted();
    const item = { fileId: file.id, path: file.path, status: file.eligibility, minimumCalls: 0 };
    if (file.eligibility !== 'reviewable') return item;
    const prepared = preparePrimaryInput(input, file, options);
    return { ...item, ...prepared.metadata, status: prepared.budget.fits ? 'ready' : 'input-blocked', minimumCalls: prepared.budget.fits ? 1 : 0 };
  });
  return { snapshotId: input.id, maxInputBytes: options.maxInputBytes, items, minimumCalls: items.reduce((sum,item) => sum + item.minimumCalls, 0), initialRequestsOnly: true };
}
