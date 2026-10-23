import { riskPlanningDecision } from './risk-plan.mjs';
import { INLINE_RISK_INSTRUCTIONS } from './prompts.mjs';
import { initialInputBudget } from './input-budget.mjs';

export function riskPlanningMode(value = 'separate') {
  if (!['auto', 'separate'].includes(value)) throw new Error('riskPlanningMode must be auto or separate');
  return value;
}

// One pure decision over the actual prepared envelope, shared by preview and execution.
// It never reads sources, changes payloads, expands scope or forces window preparation.
export function chooseRiskStrategy(input, file, prepared, options) {
  const mode = riskPlanningMode(options.riskPlanningMode);
  const decision = options.enableRiskPlanning === true
    ? options.skipSmallRiskPlans === true ? riskPlanningDecision([file]) : { required: true, reason: 'unconditional' }
    : { required: false, reason: 'disabled' };
  const fallback = { mode: decision.required ? 'separate' : 'disabled', decision, instructions: options.instructions };
  if (mode !== 'auto' || !decision.required || input.projectScope || file.reviewMode === 'project' || (options.round ?? 1) !== 1 ||
      prepared.batches !== undefined || prepared.synthesis !== undefined || prepared.metadata?.sourceMode) return fallback;
  const payload = JSON.parse(prepared.payload);
  if (payload.projectScope || payload.sourceMode || payload.windows || payload.file?.id !== file.id ||
      typeof payload.file?.left?.text !== 'string' || typeof payload.file?.right?.text !== 'string' ||
      payload.file.left.text !== file.left.text || payload.file.right.text !== file.right.text) return fallback;
  const instructions = options.instructions + '\n' + INLINE_RISK_INSTRUCTIONS;
  const budget = initialInputBudget({ instructions, input: prepared.payload }, options.scope, options.maxInputBytes);
  return budget.fits ? { mode: 'inline', decision, instructions, budget } : fallback;
}
