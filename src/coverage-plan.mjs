import { prepareInteractionInput } from './interaction-input.mjs';
import { initialInputBudget } from './input-budget.mjs';
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
    return { ...item, ...prepared.metadata, status: prepared.budget.fits ? 'ready' : 'input-blocked', minimumCalls: prepared.budget.fits ? ((prepared.batches?.length ?? 1) * (options.enableRiskPlanning === true ? 2 : 1) + (prepared.synthesis?.budget.fits ? 1 : 0)) : 0 };
  });
  const interactions = options.scope && options.grouping ? options.grouping.groups.filter(g => g.fileIds.length > 1).map(group => { const prepared = prepareInteractionInput(input, group, payload => initialInputBudget({ instructions: options.instructions, input: payload }, options.scope, options.maxInputBytes)); return { groupId: group.id, fileIds: prepared.fileIds, status: prepared.status, reason: prepared.reason, minimumCalls: prepared.status === 'ready' ? (options.enableRiskPlanning === true ? 2 : 1) : 0 }; }) : [];
  const businessGrouping = options.enableBusinessGrouping === true && input.files.filter(f => f.eligibility === 'reviewable').length > 1 ? { minimumCalls: 1, dynamicInteractionCalls: 'unknown-until-execution', maximumAdditionalInitialCalls: Math.floor(input.files.filter(f => f.eligibility === 'reviewable').length / 2) * (options.enableRiskPlanning === true ? 2 : 1), notice: '模型分组假设仅调度，额外综合动态且不保证预算或覆盖。' } : null;
  return { ...(businessGrouping ? { businessGrouping } : {}), interactions, snapshotId: input.id, maxInputBytes: options.maxInputBytes, items, minimumCalls: (businessGrouping?.minimumCalls ?? 0) + items.reduce((sum,item) => sum + item.minimumCalls, 0) + interactions.reduce((sum,item) => sum + item.minimumCalls, 0), initialRequestsOnly: true };
}
