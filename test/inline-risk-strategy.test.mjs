import test from 'node:test';
import assert from 'node:assert/strict';
import { preparePrimaryInput } from '../src/primary-input.mjs';
import { buildCoveragePlan } from '../src/coverage-plan.mjs';
import { chooseRiskStrategy, riskPlanningMode } from '../src/risk-strategy.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { initialInputBudget } from '../src/input-budget.mjs';
import { REVIEW_INSTRUCTIONS, INLINE_RISK_INSTRUCTIONS, RISK_PLAN_SCHEMA } from '../src/prompts.mjs';
import { validateRiskPlan } from '../src/risk-plan.mjs';
import { modelContract } from '../src/model-contract.mjs';
import { createHash } from 'node:crypto';

function fixture(lines = 1) {
  return { id: 'snap', files: [{ id: 'f', path: 'main.js', eligibility: 'reviewable', properties: [],
    left: { text: Array.from({ length: lines }, (_, i) => 'before' + i).join('\n') },
    right: { text: Array.from({ length: lines }, (_, i) => 'after' + i).join('\n') },
  }], context: [], rules: [] };
}
function options(input, extra = {}) {
  return { instructions: REVIEW_INSTRUCTIONS, scope: createRetrievalScope(input), maxInputBytes: 96000,
    enableRiskPlanning: true, riskPlanningMode: 'auto', ...extra };
}
const prepare = (input, opts) => preparePrimaryInput(input, input.files[0], opts);
const coverage = (input, opts) => buildCoveragePlan(input, opts).items[0];
// Auto mode additionally discloses why it retained the exact ordinary transport.
function withoutFallback(value) { const copy = structuredClone(value); if (copy.metadata) delete copy.metadata.riskPlanningFallbackReason; if (copy.items) copy.items.forEach(item => delete item.riskPlanningFallbackReason); return copy; }

test('mode validates strictly and legacy default/separate preserve exact preparation and budgets', () => {
  assert.equal(riskPlanningMode(), 'separate');
  for (const value of [null, '', 'inline', 'AUTO', 1, false, {}]) assert.throws(() => riskPlanningMode(value));
  const input = fixture(), opts = options(input), legacyOpts = { ...opts }; delete legacyOpts.riskPlanningMode;
  const legacy = prepare(input, legacyOpts), separate = prepare(input, { ...opts, riskPlanningMode: 'separate' });
  assert.deepEqual(separate, legacy);
  assert.equal(legacy.inlineRisk, undefined); assert.equal(legacy.instructions, undefined);
  assert.deepEqual(legacy.budget, initialInputBudget({ instructions: REVIEW_INSTRUCTIONS, input: legacy.payload }, opts.scope, opts.maxInputBytes));
  assert.equal(coverage(input, legacyOpts).minimumCalls, 2);
  assert.deepEqual(coverage(input, legacyOpts), coverage(input, { ...opts, riskPlanningMode: 'separate' }));
  assert.throws(() => prepare(input, { ...opts, riskPlanningMode: 'inline' }));
  assert.throws(() => buildCoveragePlan({ id: 'empty', files: [] }, { ...opts, riskPlanningMode: null }));
});

test('auto fullbody uses exact combined instructions with no reader calls or payload changes', () => {
  const input = fixture(), opts = options(input), before = structuredClone(input);
  const prepared = prepare(input, opts), ordinary = prepare(input, { ...opts, riskPlanningMode: 'separate' });
  assert.equal(prepared.inlineRisk, true);
  assert.equal(prepared.instructions, REVIEW_INSTRUCTIONS + '\n' + INLINE_RISK_INSTRUCTIONS);
  assert.equal(prepared.payload, ordinary.payload);
  assert.equal(prepared.batches, undefined); assert.equal(prepared.synthesis, undefined);
  assert.equal(prepared.metadata.riskPlanningMode, 'inline');
  assert.deepEqual(prepared.budget, initialInputBudget({ instructions: prepared.instructions, input: prepared.payload }, opts.scope, opts.maxInputBytes));
  assert.equal(prepared.metadata.initialInputBytes, prepared.budget.bytes);
  assert.deepEqual(input, before); assert.deepEqual(opts.scope.usage(), { calls: 0, outputBytes: 0 });
  const strategy = chooseRiskStrategy(input, input.files[0], prepared, opts);
  assert.equal(strategy.mode, 'inline'); assert.equal(strategy.instructions, prepared.instructions);
  const plan = coverage(input, opts);
  assert.equal(plan.minimumCalls, 1); assert.equal(plan.riskPlanning.mode, 'inline');
  assert.equal(plan.riskPlanning.required, true); assert.equal(plan.initialInputBytes, prepared.budget.bytes);
  assert.equal(buildCoveragePlan(input, { ...opts, reviewRounds: 3 }).minimumCalls, 3);
});

test('actual combined envelope fits inclusively; one byte less falls back to unchanged ordinary fullbody', () => {
  const input = fixture(), opts = options(input), broad = prepare(input, opts), exactBytes = broad.budget.bytes;
  const exact = prepare(input, { ...opts, maxInputBytes: exactBytes });
  assert.equal(exact.inlineRisk, true); assert.equal(exact.budget.bytes, exactBytes);
  const belowOpts = { ...opts, maxInputBytes: exactBytes - 1 };
  const below = prepare(input, belowOpts), ordinary = prepare(input, { ...belowOpts, riskPlanningMode: 'separate' });
  assert.deepEqual(withoutFallback(below), ordinary); assert.equal(below.metadata.riskPlanningFallbackReason, 'input-budget'); assert.equal(below.inlineRisk, undefined);
  assert.equal(below.batches, undefined); assert.equal(below.budget.fits, true);
  assert.equal(coverage(input, belowOpts).minimumCalls, 2);
  assert.equal(coverage(input, { ...opts, maxInputBytes: exactBytes }).minimumCalls, 1);
});

test('auto keeps ordinary windows and blocks rather than forcing fullbody or larger instructions', () => {
  const input = fixture(1000), opts = options(input, { maxInputBytes: 9000 });
  const auto = prepare(input, opts), ordinary = prepare(input, { ...opts, riskPlanningMode: 'separate' });
  assert.deepEqual(withoutFallback(auto), ordinary); assert.ok(auto.metadata.riskPlanningFallbackReason); assert.equal(auto.inlineRisk, undefined);
  assert.equal(auto.metadata.sourceMode, 'change-windows');
  assert.deepEqual(withoutFallback(buildCoveragePlan(input, opts)), buildCoveragePlan(input, { ...opts, riskPlanningMode: 'separate' }));
  const blockedOpts = { ...opts, scope: undefined, maxInputBytes: 100 };
  assert.deepEqual(withoutFallback(prepare(input, blockedOpts)), prepare(input, { ...blockedOpts, riskPlanningMode: 'separate' }));
  assert.equal(coverage(input, blockedOpts).minimumCalls, 0);
});

test('project sentinel later rounds disabled and small-change skips never inline', () => {
  for (const make of [
    () => { const input = fixture(); input.projectScope = { inventoryScope: 'selected' }; return [input, {}]; },
    () => { const input = fixture(); input.files[0].reviewMode = 'project'; return [input, {}]; },
    () => [fixture(), { round: 2 }], () => [fixture(), { round: 3 }],
    () => [fixture(), { enableRiskPlanning: false }], () => [fixture(), { skipSmallRiskPlans: true }],
  ]) {
    const [input, extra] = make(), opts = options(input, extra);
    assert.deepEqual(withoutFallback(prepare(input, opts)), prepare(input, { ...opts, riskPlanningMode: 'separate' })); assert.ok(prepare(input, opts).metadata.riskPlanningFallbackReason);
    assert.equal(coverage(input, opts).riskPlanning.mode, undefined);
  }
  const input = fixture(30), opts = options(input, { skipSmallRiskPlans: true });
  assert.equal(prepare(input, opts).inlineRisk, true);
  assert.equal(coverage(input, opts).riskPlanning.reason, 'file-threshold');
});

test('history and old-only context remain exact and independently approved; no scope grants sources', () => {
  const input = fixture();
  input.history = { base: 'a'.repeat(40), target: 'b'.repeat(40) };
  input.context = [{ path: 'old.js', oldOnly: true, oldText: 'OLD\r\n', oldRevision: input.history.base,
    oldBlobOid: 'c'.repeat(40), oldHash: createHash('sha256').update('OLD\r\n').digest('hex') }];
  // Without a scope, inline may only list [] sourceIds; no new source authority is created.
  const opts = options(fixture(), { scope: undefined });
  const prepared = prepare(input, opts), payload = JSON.parse(prepared.payload);
  assert.equal(prepared.inlineRisk, true); assert.deepEqual(payload.context, input.context);
  assert.equal(payload.context[0].text, undefined); assert.deepEqual(payload.contextSideNotice.length > 0, true);
  assert.ok(INLINE_RISK_INSTRUCTIONS.includes('no catalog: []'));
  const scopedOptions = options(input);
  assert.equal(prepare(input, scopedOptions).inlineRisk, true);
  assert.deepEqual(scopedOptions.scope.catalog().filter(s => s.path === 'old.js').map(s => s.side), ['context-old']);
});

test('combined prompt allows findings with optional independently validated risks and retrieval requests', () => {
  assert.ok(!INLINE_RISK_INSTRUCTIONS.includes(RISK_PLAN_SCHEMA));
  assert.ok(!INLINE_RISK_INSTRUCTIONS.includes('仅制定审查计划'));
  assert.ok(INLINE_RISK_INSTRUCTIONS.includes('Final JSON requires findings/limitations'));
  assert.match(INLINE_RISK_INSTRUCTIONS, /Intermediate requests allowed/);
  assert.ok(Buffer.byteLength(INLINE_RISK_INSTRUCTIONS) <= 1024);
  const input = fixture(), prepared = prepare(input, options(input));
  assert.match(modelContract(prepared.payload, prepared.instructions), /findings/);
  assert.doesNotMatch(modelContract(prepared.payload, prepared.instructions), /上述risks schema/);
  const risks = [{ id: 'r1', fileIds: ['f'], editRefs: [{ fileId: 'f', editId: prepared.changes.edits[0].id }],
    question: 'risk?', trigger: 'condition', impact: 'failure', checks: ['find counterevidence'], sourceIds: [] }];
  assert.equal(validateRiskPlan({ risks }, [{ fileId: 'f', edits: prepared.changes.edits }], []).length, 1);
});

test('shared chooser rejects pre-windowed partial multi-batch or mismatched envelopes without reading', () => {
  const input = fixture(), opts = options(input), prepared = prepare(input, { ...opts, riskPlanningMode: 'separate' });
  for (const patch of [{ batches: [] }, { batches: [{ payload: prepared.payload }] }, { synthesis: {} },
    { payload: JSON.stringify({ ...JSON.parse(prepared.payload), sourceMode: 'file-interaction' }) },
    { payload: JSON.stringify({ ...JSON.parse(prepared.payload), windows: [] }) },
    { payload: JSON.stringify({ ...JSON.parse(prepared.payload), file: { id: 'f', left: { text: '' }, right: { text: '' } } }) },
  ]) assert.equal(chooseRiskStrategy(input, input.files[0], { ...prepared, ...patch }, opts).mode, 'separate');
  assert.deepEqual(opts.scope.usage(), { calls: 0, outputBytes: 0 });
});
