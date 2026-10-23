import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalRiskInput } from '../src/risk-scope.mjs';
import { preparePrimaryInput } from '../src/primary-input.mjs';
import { buildCoveragePlan } from '../src/coverage-plan.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { initialInputBudget } from '../src/input-budget.mjs';
import { RISK_PLAN_INSTRUCTIONS } from '../src/risk-plan.mjs';
import { REVIEW_INSTRUCTIONS } from '../src/review.mjs';
import { hash } from '../src/content.mjs';

function fixture() {
  const lines = Array.from({ length: 100 }, (_, i) => 'line' + i + 'x'.repeat(200));
  const changed = [...lines]; changed[10] = 'changed10'; changed[80] = 'changed80';
  const file = { id: 'f', path: 'large.js', eligibility: 'reviewable', properties: [],
    left: { text: lines.join('\n') }, right: { text: changed.join('\n') }, rightExists: true };
  return { id: 's', vcs: 'git', context: [], files: [file] };
}
function config(input, overrides = {}) {
  return { instructions: REVIEW_INSTRUCTIONS, scope: createRetrievalScope(input), maxInputBytes: 8000, ...overrides };
}
const riskOptions = options => ({ ...options, instructions: RISK_PLAN_INSTRUCTIONS });

test('single primary preserves exact original payload including body, grouped context and rule compatibility', () => {
  const input = { id: 'simple', vcs: 'git', context: [{ path: 'context.js', text: 'CONTEXT BODY' }],
    rules: [{ path: 'rules.md', text: 'RULE BODY' }],
    files: [{ id: 'f', path: 'a.js', eligibility: 'reviewable', properties: [], left: { text: 'before' }, right: { text: 'after' } }] };
  const options = config(input, { maxInputBytes: 96000 });
  const prepared = preparePrimaryInput(input, input.files[0], options);
  assert.equal(prepared.batches, undefined);
  const canonical = canonicalRiskInput(input, input.files[0], prepared, riskOptions(options));
  assert.equal(canonical.cacheable, true);
  assert.equal(canonical.payload, prepared.payload);
  assert.ok(canonical.payload.includes('CONTEXT BODY'));
  assert.ok(canonical.payload.includes('RULE BODY'));
  assert.deepEqual(canonicalRiskInput(input, input.files[0], prepared, { ...riskOptions(options), maxInputBytes: 1 }), { cacheable: false });
});

test('canonical multiwindow plan covers every complete edit, not first-window evidence, without source bodies or reads', () => {
  const input = fixture(), file = input.files[0], options = config(input);
  const prepared = preparePrimaryInput(input, file, options);
  assert.equal(prepared.batches.length, 2);
  const before = structuredClone({ input, prepared });
  const canonical = canonicalRiskInput(input, file, prepared, riskOptions(options));
  assert.equal(canonical.cacheable, true);
  const payload = JSON.parse(canonical.payload);
  assert.equal(payload.sourceMode, 'risk-all-edits');
  assert.deepEqual(payload.changes.edits, prepared.changes.edits);
  assert.equal(payload.changes.edits.length, 2);
  assert.equal(payload.changes.edits[1].id, 'e2');
  assert.equal(payload.changes.edits[1].new.start, 81);
  assert.equal(payload.file.id, file.id);
  assert.equal(payload.file.left.hash, hash(file.left.text));
  assert.equal(payload.file.right.hash, hash(file.right.text));
  assert.equal(payload.file.leftExists, null, 'missing baseline metadata is not evidence of absence');
  assert.equal(payload.file.rightExists, true);
  assert.equal(payload.file.left.text, undefined);
  assert.equal(payload.file.right.text, undefined);
  assert.equal(payload.windows, undefined);
  assert.equal(payload.context, undefined);
  assert.ok(!canonical.payload.includes('changed10'));
  assert.ok(!canonical.payload.includes('changed80'));
  assert.deepEqual(payload.catalog, options.scope.catalog());
  assert.deepEqual(payload.defectGuidance, JSON.parse(prepared.payload).defectGuidance);
  assert.equal(options.scope.usage().calls, 0);
  assert.deepEqual({ input, prepared }, before);
  const reversed = { ...prepared, payload: prepared.batches[1].payload, batches: [...prepared.batches].reverse() };
  assert.equal(canonicalRiskInput(input, file, reversed, riskOptions(options)).payload, canonical.payload);
});

test('canonical metadata retains approved rules, requirement and history but context bodies stay in approved catalog', () => {
  const input = fixture();
  input.context = [{ path: 'context.js', text: 'CONTEXT BODY NOT A WINDOW EVIDENCE' }];
  input.rules = [{ path: 'rules.md', hash: 'rule-hash', text: 'RETAIN ALL RULE TEXT' }];
  input.businessRequirement = 'Retain the documented behavior';
  input.history = { mode: 'range', base: 'a'.repeat(40), target: 'b'.repeat(40) };
  const options = config(input, { maxInputBytes: 10000 }), file = input.files[0];
  const prepared = preparePrimaryInput(input, file, options);
  assert.ok(prepared.batches.length > 1);
  const canonical = canonicalRiskInput(input, file, prepared, riskOptions(options));
  assert.equal(canonical.cacheable, true);
  const payload = JSON.parse(canonical.payload);
  assert.deepEqual(payload.history, input.history);
  assert.deepEqual(payload.rules, input.rules);
  assert.equal(payload.businessRequirement, input.businessRequirement);
  assert.match(payload.contextSideNotice, /baseline/);
  assert.ok(payload.requirementNotice);
  assert.ok(payload.catalog.some(source => source.path === 'context.js'));
  assert.ok(!canonical.payload.includes('CONTEXT BODY NOT A WINDOW EVIDENCE'));
  assert.equal(options.scope.usage().calls, 0);
});

test('all-edit cacheability measures actual risk instructions, catalog and budget at exact boundary', () => {
  const input = fixture(), file = input.files[0], options = config(input);
  const prepared = preparePrimaryInput(input, file, options);
  const canonical = canonicalRiskInput(input, file, prepared, riskOptions(options));
  const bytes = initialInputBudget({ instructions: RISK_PLAN_INSTRUCTIONS, input: canonical.payload }, options.scope, 100000).bytes;
  assert.equal(canonicalRiskInput(input, file, prepared, { ...riskOptions(options), maxInputBytes: bytes }).cacheable, true);
  assert.deepEqual(canonicalRiskInput(input, file, prepared, { ...riskOptions(options), maxInputBytes: bytes - 1 }), { cacheable: false });
  assert.deepEqual(canonicalRiskInput(input, file, prepared, { ...riskOptions(options), scope: undefined }), { cacheable: false });
  assert.deepEqual(canonicalRiskInput(input, file, { ...prepared, changes: undefined }, riskOptions(options)), { cacheable: false });
});

test('full edit metadata overflow falls back without truncation or first-window substitution', () => {
  const input = fixture(), file = input.files[0], options = config(input);
  const prepared = preparePrimaryInput(input, file, options);
  const edits = Array.from({ length: 1000 }, (_, i) => ({ id: 'e' + i, old: { start: i + 1, count: 1 }, new: { start: i + 1, count: 1 } }));
  const all = { ...prepared, changes: { ...prepared.changes, edits } };
  assert.deepEqual(canonicalRiskInput(input, file, all, riskOptions(options)), { cacheable: false });
  assert.equal(all.changes.edits.length, 1000);
  assert.equal(all.payload, prepared.payload);
});

test('file identity preserves captured hash and explicit absent sides without treating project sentinel as history', () => {
  const input = fixture(), options = config(input), file = input.files[0];
  const prepared = preparePrimaryInput(input, file, options);
  const modified = { ...file, leftExists: false, rightExists: false,
    left: { ...file.left, hash: 'captured-left', bytes: 0, encoding: 'utf-8' },
    right: { ...file.right, hash: 'captured-right', bytes: 10, encoding: 'utf-16le' } };
  input.projectScope = { mode: 'project', inventoryScope: 'selected' };
  input.changeScope = 'staged';
  const payload = JSON.parse(canonicalRiskInput(input, modified, prepared, riskOptions(options)).payload);
  assert.deepEqual(payload.file.left, { hash: 'captured-left', bytes: 0, encoding: 'utf-8' });
  assert.deepEqual(payload.file.right, { hash: 'captured-right', bytes: 10, encoding: 'utf-16le' });
  assert.equal(payload.file.leftExists, false);
  assert.equal(payload.file.rightExists, false);
  assert.deepEqual(payload.projectScope, input.projectScope);
  assert.match(payload.reviewNotice, /sentinel/);
  assert.equal(payload.changeScope, 'staged');
});

test('coverage minimum counts canonical planning once, all primary rounds and synthesis separately', () => {
  const input = fixture(), options = config(input);
  const prepared = preparePrimaryInput(input, input.files[0], options);
  const batches = prepared.batches.length;
  assert.equal(batches, 2);
  assert.equal(prepared.synthesis.status, 'ready');
  const plan = buildCoveragePlan(input, { ...options, enableRiskPlanning: true, reviewRounds: 3 });
  assert.equal(plan.minimumCalls, batches * 3 + 1 + 3);
  assert.equal(plan.items[0].riskPlanning.required, true);
  assert.ok(!JSON.stringify(plan).includes('changed80'));
  const disabled = buildCoveragePlan(input, { ...options, enableRiskPlanning: false, reviewRounds: 2 });
  assert.equal(disabled.minimumCalls, batches * 2 + 2);
  const thresholdSkipped = buildCoveragePlan(input, { ...options, enableRiskPlanning: true, skipSmallRiskPlans: true });
  assert.equal(thresholdSkipped.items[0].riskPlanning.required, false);
  assert.equal(thresholdSkipped.minimumCalls, batches + 1);
});

test('coverage falls back to per-primary planning when complete canonical metadata does not fit', () => {
  const input = fixture();
  // History metadata is not part of existing per-window body payloads; canonical
  // inclusion must either fit completely or retain per-window planning behavior.
  input.history = { mode: 'range', semantics: 'scope'.repeat(5000) };
  const options = config(input, { maxInputBytes: 9000 }), prepared = preparePrimaryInput(input, input.files[0], options);
  assert.equal(prepared.budget.fits, true);
  assert.equal(prepared.batches.length, 2);
  assert.equal(canonicalRiskInput(input, input.files[0], prepared, riskOptions(options)).cacheable, false);
  const plan = buildCoveragePlan(input, { ...options, enableRiskPlanning: true, reviewRounds: 2 });
  const synthesisCalls = prepared.synthesis.status === 'ready' ? 2 : 0;
  assert.equal(plan.minimumCalls, prepared.batches.length * 3 + synthesisCalls);
});
