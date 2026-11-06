import { isDeepStrictEqual } from 'node:util';
import { prepareInteractionInput } from './interaction-input.mjs';
import { riskPlanningDecision, validateRiskPlan } from './risk-plan.mjs';
import { initialInputBudget } from './input-budget.mjs';
import { INLINE_RISK_INSTRUCTIONS } from './prompts.mjs';

// Reuse the existing optional-risks schema. Do not add the planning-only schema
// which forbids findings and requests. Interaction references remain file-qualified.
export const INTERACTION_RISK_INSTRUCTIONS = 'INLINE_INTERACTION_RISKS ' + INLINE_RISK_INSTRUCTIONS +
  ' Interaction risks must reference real edits in at least two distinct files from this interaction group. The supplied files[].edits cover the complete exact group edits, not source evidence. Source bodies must still be read in this generation; hypotheses never replace interaction evidence or independent verification. Missing or invalid optional risks do not invalidate findings and must not trigger another planning call.';

function canonicalInteraction(snapshot, group) {
  const prepared = prepareInteractionInput(snapshot, group, () => ({ fits: true }));
  return prepared.status === 'ready' ? JSON.parse(prepared.payload) : undefined;
}

/** Pure first-generation decision; no reads, receipts, state mutation or model sends. */
export function prepareInteractionRisk(snapshot, group, prepared, options) {
  const { instructions, scope, maxInputBytes } = options;
  if (options.inlineInteractionRisks !== undefined && typeof options.inlineInteractionRisks !== 'boolean') throw new Error('inlineInteractionRisks must be boolean');
  const files = group.fileIds.map(id => snapshot.files.find(file => file.id === id));
  const decision = options.enableRiskPlanning === true
    ? options.skipSmallRiskPlans === true ? riskPlanningDecision(files) : { required: true, reason: 'unconditional' }
    : { required: false, reason: 'disabled' };
  const fallback = fallbackReason => ({ mode: decision.required ? 'separate' : 'disabled', decision,
    instructions, planningCalls: decision.required ? 1 : 0, fallbackReason });
  if (!decision.required) return fallback(options.enableRiskPlanning === true ? 'smallchange' : 'disabled');
  if (options.inlineInteractionRisks !== true) return fallback('option-disabled');
  if (snapshot.projectScope || files.some(file => file?.reviewMode === 'project')) return fallback('project');
  if ((options.round ?? 1) !== 1) return fallback('laterround');
  if (!scope) return fallback('approved-reader-required');
  if (prepared?.status !== 'ready' || prepared.budget?.fits !== true || prepared.batches !== undefined) return fallback('incomplete-edit-scope');
  let canonical, payload;
  try {
    canonical = canonicalInteraction(snapshot, group);
    payload = JSON.parse(prepared.payload);
  } catch { return fallback('incomplete-edit-scope'); }
  if (!canonical || !payload || payload.snapshotId !== snapshot.id || payload.groupId !== group.id ||
      payload.sourceMode !== 'file-interaction' || !isDeepStrictEqual(prepared.fileIds, group.fileIds) ||
      !isDeepStrictEqual(payload.files, canonical.files)) return fallback('incomplete-edit-scope');
  const combined = instructions + '\n' + INTERACTION_RISK_INSTRUCTIONS;
  // Exactly the same retrieval envelope and native/text wire policy as execution.
  const budget = initialInputBudget({ instructions: combined, input: prepared.payload, maxRetrievalRounds: options.maxRetrievalRounds,
    ...(options.nativeOutputTools !== undefined ? { nativeOutputTools: options.nativeOutputTools } : {}) }, scope, maxInputBytes);
  return budget.fits ? { mode: 'inline', decision, instructions: combined, budget, planningCalls: 0 }
    : fallback('input-budget');
}

/** Separate optional hypotheses from the unchanged final findings envelope.
 * Malformed stage JSON still throws; missing/invalid optional risks never do.
 * No arbitrary exception message or untrusted hypothesis text enters limitations.
 */
export function consumeInteractionRisks(response, snapshot, group, catalog = []) {
  // The stage transport already bounds the complete response. Do not reject a
  // sound findings envelope just because optional risks exceed their own limit.
  const decoded = typeof response === 'string' ? JSON.parse(response) : structuredClone(response);
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('Invalid interaction response');
  const { risks, ...rest } = decoded;
  if (!Object.hasOwn(decoded, 'risks')) return { response: rest, risk: { status: 'absent', method: 'inline', risks: [],
    reason: 'optional-risks-missing', limitation: '交互内联风险未返回；保留可独立校验的发现，未补发规划。' } };
  try {
    const canonical = canonicalInteraction(snapshot, group);
    if (!canonical) throw new Error('Inexact interaction');
    const hypotheses = validateRiskPlan({ risks }, canonical.files, catalog);
    if (hypotheses.some(risk => new Set(risk.editRefs.map(ref => ref.fileId)).size < 2)) throw new Error('Single-file hypothesis');
    return { response: rest, risk: { status: 'completed', method: 'inline', reason: 'inline-interaction', risks: hypotheses } };
  } catch {
    return { response: rest, risk: { status: 'invalid', method: 'inline', risks: [], reason: 'optional-risks-invalid',
      limitation: '交互内联风险无效；保留可独立校验的发现，风险不作为证据，未补发规划。' } };
  }
}
