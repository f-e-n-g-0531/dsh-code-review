import { riskPlanningDecision } from './risk-plan.mjs';
import { INLINE_RISK_INSTRUCTIONS } from './prompts.mjs';
import { initialInputBudget } from './input-budget.mjs';
import { changeMap } from './change-map.mjs';
import { changeWindows } from './change-windows.mjs';
import { sourceSegments } from './source-segments.mjs';
import { isDeepStrictEqual } from 'node:util';

export function riskPlanningMode(value = 'separate') {
  if (!['auto', 'separate'].includes(value)) throw new Error('riskPlanningMode must be auto or separate');
  return value;
}

// Compare the entire host projection, not just edit IDs: a claimed edit can be
// split across several windows and both sides (including zero counts) must match.
function completeWindowScope(file, prepared, payload) {
  if (payload.sourceMode !== 'change-windows' || prepared.metadata?.sourceMode !== 'change-windows' ||
      prepared.synthesis !== undefined || prepared.metadata?.windowBlocked?.length ||
      (prepared.metadata?.batchCount !== undefined && prepared.metadata.batchCount !== 1) ||
      (prepared.batches !== undefined && prepared.batches.length !== 1)) return false;
  const changes = changeMap(file.left.text, file.right.text);
  if (changes.status !== 'changed' || changes.precision !== 'exact' || !changes.edits.length ||
      !isDeepStrictEqual(prepared.changes, changes) || !isDeepStrictEqual(payload.changes, changes)) return false;
  const projected = changeWindows(file, changes);
  if (!projected) return false;
  const windows = sourceSegments(projected), ids = windows.map(w => w.id);
  if (!isDeepStrictEqual(payload.windows, windows) || !isDeepStrictEqual(prepared.metadata.windowIds, ids)) return false;
  const referenced = new Set(windows.flatMap(w => w.editIds));
  if (referenced.size !== changes.edits.length || changes.edits.some(e => !referenced.has(e.id))) return false;
  const compact = { ...file, left: { ...file.left, text: undefined }, right: { ...file.right, text: undefined } };
  // JSON transport omits undefined; retained hashes/encoding/existence/identity
  // must still be identical to the approved file, never another source copy.
  if (!isDeepStrictEqual(payload.file, JSON.parse(JSON.stringify(compact)))) return false;
  if (prepared.batches !== undefined) {
    const batch = prepared.batches[0];
    if (batch.payload !== prepared.payload || !isDeepStrictEqual(batch.windowIds, ids)) return false;
  }
  return true;
}

// One pure decision over the actual prepared envelope, shared by preview and execution.
// It never reads sources, changes payloads, expands scope or forces window preparation.
export function chooseRiskStrategy(input, file, prepared, options) {
  const mode = riskPlanningMode(options.riskPlanningMode);
  const decision = options.enableRiskPlanning === true
    ? options.skipSmallRiskPlans === true ? riskPlanningDecision([file]) : { required: true, reason: 'unconditional' }
    : { required: false, reason: 'disabled' };
  const fallback = fallbackReason => ({ mode: decision.required ? 'separate' : 'disabled', decision, instructions: options.instructions, fallbackReason });
  if (mode !== 'auto') return fallback('mode-notauto');
  if (!decision.required) return fallback(options.enableRiskPlanning === true ? 'smallchange' : 'disabled');
  if (input.projectScope || file.reviewMode === 'project') return fallback('project');
  if ((options.round ?? 1) !== 1) return fallback('laterround');
  if (prepared.batches?.length > 1) return fallback('multi-batch');
  if (typeof file.left?.text !== 'string' || typeof file.right?.text !== 'string') return fallback('incomplete-edit-scope');
  let payload;
  try { payload = JSON.parse(prepared.payload); } catch { return fallback('incomplete-edit-scope'); }
  if (!payload || payload.projectScope || payload.file?.id !== file.id) return fallback('incomplete-edit-scope');
  if (payload.sourceMode === 'change-windows') {
    if (payload.snapshotId !== input.id || !completeWindowScope(file, prepared, payload)) return fallback('incomplete-edit-scope');
  } else if (payload.sourceMode || payload.windows || prepared.batches !== undefined || prepared.synthesis !== undefined ||
      prepared.metadata?.sourceMode || payload.file?.left?.text !== file.left.text || payload.file?.right?.text !== file.right.text) {
    return fallback('incomplete-edit-scope');
  }
  const instructions = options.instructions + '\n' + INLINE_RISK_INSTRUCTIONS;
  const budget = initialInputBudget({ instructions, input: prepared.payload }, options.scope, options.maxInputBytes);
  return budget.fits ? { mode: 'inline', decision, instructions, budget } : fallback('input-budget');
}
