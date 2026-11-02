import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareInteractionRisk, consumeInteractionRisks, INTERACTION_RISK_INSTRUCTIONS } from '../src/interaction-risk.mjs';
import { prepareInteractionInput } from '../src/interaction-input.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { initialInputBudget } from '../src/input-budget.mjs';
import { configureWireBudget } from '../src/model-wire-budget.mjs';
import { REVIEW_INSTRUCTIONS, RISK_PLAN_SCHEMA } from '../src/prompts.mjs';
import { modelResultTools } from '../src/model-tools.mjs';
import { modelContract } from '../src/model-contract.mjs';
import { validateInteractionFindings } from '../src/interaction-findings.mjs';

function fixture(lines = 1, native = false) {
  const snapshot = { id: 's', context: [], rules: [], files: ['a', 'b'].map(id => ({ id, path: id + '.js', eligibility: 'reviewable', properties: [],
    left: { text: Array.from({ length: lines }, (_, i) => 'old' + id + i + '\r\n').join('') },
    right: { text: Array.from({ length: lines }, (_, i) => 'new' + id + i + '\r\n').join('') } })) };
  const group = { id: 'g', fileIds: ['a', 'b'] }, scope = createRetrievalScope(snapshot);
  if (native) configureWireBudget(scope, { nativeOutputTools: true });
  const options = { instructions: REVIEW_INSTRUCTIONS, scope, maxInputBytes: 96000, enableRiskPlanning: true, inlineInteractionRisks: true,
    ...(native ? { nativeOutputTools: true } : {}) };
  const prepared = prepareInteractionInput(snapshot, group, payload => initialInputBudget({ instructions: options.instructions, input: payload }, scope, options.maxInputBytes));
  return { snapshot, group, prepared, options, scope };
}
const prepare = f => prepareInteractionRisk(f.snapshot, f.group, f.prepared, f.options);
const risk = () => ({ id: 'r1', fileIds: ['a', 'b'], editRefs: [{ fileId: 'a', editId: 'e1' }, { fileId: 'b', editId: 'e1' }],
  question: 'Can the edit pair break a shared invariant?', trigger: 'Both paths active', impact: 'inconsistent state', checks: ['Find protection on both sides'], sourceIds: ['s1', 's4'] });
const consume = (f, response) => consumeInteractionRisks(response, f.snapshot, f.group, f.scope.catalog());

for (const native of [false, true]) test('inline interaction saves one planning call with exact merged wire budget: ' + native, () => {
  const f = fixture(1, native), before = structuredClone(f.snapshot), preparedBefore = structuredClone(f.prepared), strategy = prepare(f);
  assert.equal(strategy.mode, 'inline'); assert.equal(strategy.planningCalls, 0);
  assert.equal(strategy.instructions, REVIEW_INSTRUCTIONS + '\n' + INTERACTION_RISK_INSTRUCTIONS);
  assert.equal(strategy.decision.required, true);
  assert.deepEqual(strategy.budget, initialInputBudget({ instructions: strategy.instructions, input: f.prepared.payload,
    ...(native ? { nativeOutputTools: true } : {}) }, f.scope, 96000));
  assert.deepEqual(f.snapshot, before); assert.deepEqual(f.prepared, preparedBefore); assert.equal(f.scope.usage().calls, 0);
  f.options.maxInputBytes = strategy.budget.bytes; assert.equal(prepare(f).mode, 'inline');
  f.options.maxInputBytes--; const fallback = prepare(f);
  assert.equal(fallback.mode, 'separate'); assert.equal(fallback.fallbackReason, 'input-budget');
  assert.equal(fallback.planningCalls, 1); assert.equal(fallback.instructions, REVIEW_INSTRUCTIONS);
});

test('flag off disabled small change project later rounds or missing reader preserve separate strategy', () => {
  for (const [change, reason, mode, calls] of [
    [f => { delete f.options.inlineInteractionRisks; }, 'option-disabled', 'separate', 1],
    [f => { f.options.enableRiskPlanning = false; }, 'disabled', 'disabled', 0],
    [f => { f.options.skipSmallRiskPlans = true; }, 'smallchange', 'disabled', 0],
    [f => { f.snapshot.projectScope = {}; }, 'project', 'separate', 1],
    [f => { f.options.round = 2; }, 'laterround', 'separate', 1],
    [f => { delete f.options.scope; }, 'approved-reader-required', 'separate', 1],
  ]) { const f = fixture(); change(f); const result = prepare(f); assert.equal(result.fallbackReason, reason); assert.equal(result.mode, mode); assert.equal(result.planningCalls, calls); }
  const f = fixture(30); f.options.skipSmallRiskPlans = true; assert.equal(prepare(f).mode, 'inline');
  f.options.inlineInteractionRisks = 'true'; assert.throws(() => prepare(f), /inlineInteractionRisks must be boolean/);
});

test('all group edits and identity must match approved canonical interaction input', () => {
  for (const change of [
    p => { p.files.pop(); }, p => { p.files[0].edits[0].id = 'other'; },
    p => { p.files[0].edits[0].old.count++; }, p => { p.sourceMode = 'file-interaction-partial'; },
    p => { p.snapshotId = 'other'; }, p => { p.groupId = 'other'; }, p => { p.files[0].fileId = 'context'; },
  ]) { const f = fixture(), p = JSON.parse(f.prepared.payload); change(p); f.prepared.payload = JSON.stringify(p); assert.equal(prepare(f).fallbackReason, 'incomplete-edit-scope'); }
  for (const change of [f => { f.prepared.status = 'blocked'; }, f => { f.prepared.fileIds.reverse(); }, f => { f.prepared.batches = []; },
    f => { f.snapshot.files[0].right.text = f.snapshot.files[0].left.text; }, f => { f.snapshot.files[0].eligibility = 'excluded'; },
  ]) { const f = fixture(); change(f); assert.equal(prepare(f).fallbackReason, 'incomplete-edit-scope'); }
});

test('valid optional risks use strict validator and remain unverified hypotheses not source evidence', () => {
  const f = fixture(), input = { findings: [], limitations: [], risks: [risk()] }, before = structuredClone(input);
  const result = consume(f, input);
  assert.equal(result.risk.status, 'completed'); assert.equal(result.risk.method, 'inline'); assert.equal(result.risk.reason, 'inline-interaction');
  assert.equal(result.risk.risks[0].status, 'hypothesis'); assert.equal(result.risk.risks[0].causality, 'unverified');
  assert.deepEqual(result.response, { findings: [], limitations: [] }); assert.deepEqual(input, before);
  assert.equal(consume(f, { findings: [], limitations: [], risks: [] }).risk.status, 'completed');
  assert.equal(f.scope.usage().calls, 0);
});

test('missing and malformed optional risks never erase even byte-exact findings or add a planning send', () => {
  const f = fixture(), finding = { fileId: 'a', title: 'retained', evidence: 'exact CRLF\r\n', interaction: { editRefs: [{ fileId: 'a', editId: 'e1' }, { fileId: 'b', editId: 'e1' }] } };
  const response = { findings: [finding], limitations: ['keep me'], extension: { keep: true } };
  const absent = consume(f, response); assert.equal(absent.risk.status, 'absent'); assert.deepEqual(absent.response, response);
  for (const risks of [null, 'wrong', {}, [null], [{ ...risk(), editRefs: [{ fileId: 'a', editId: 'e1' }] }],
    [{ ...risk(), sourceIds: ['foreign'] }], [{ ...risk(), editRefs: [{ fileId: 'a', editId: 'e1' }, { fileId: 'b', editId: 'e2' }] }],
    [{ ...risk(), checks: [{}] }], [risk(), risk()], [{ ...risk(), impact: 'x'.repeat(150000) }],
  ]) {
    const raw = { ...response, risks }, before = structuredClone(raw), result = consume(f, raw);
    assert.equal(result.risk.status, 'invalid'); assert.deepEqual(result.response, response); assert.deepEqual(raw, before);
    assert.match(result.risk.limitation, /未补发规划/); assert.equal(result.risk.reason, 'optional-risks-invalid');
  }
  assert.equal(f.scope.usage().calls, 0);
  assert.throws(() => consume(f, '{bad')); assert.throws(() => consume(f, 'null'));
});

test('optional malformed risks do not make findings valid or bypass independent interaction checks', () => {
  const f = fixture(), separated = consume(f, { findings: [{ fileId: 'foreign' }], limitations: [], risks: 'invalid' });
  assert.equal(separated.risk.status, 'invalid');
  assert.throws(() => validateInteractionFindings(separated.response, f.snapshot, f.group, [], f.scope.catalog()), /outside group/);
  const validEmpty = consume(f, JSON.stringify({ findings: [], limitations: [], risks: 'invalid' }));
  assert.deepEqual(validateInteractionFindings(validEmpty.response, f.snapshot, f.group, [], f.scope.catalog()), { findings: [], limitations: [] });
});

test('independently valid interaction finding survives missing or invalid inline risks with exact read audit', () => {
  const f = fixture(), file = f.snapshot.files[0];
  const finding = { fileId: 'a', severity: 'high', title: 'contract mismatch', evidence: 'two approved edits', trigger: 'both paths',
    impact: 'state mismatch', suggestion: 'align contract', anchor: { kind: 'line', side: 'new', start: 1, end: 1, snippet: file.right.text.replace(/\r\n$/, '') },
    attribution: { editIds: ['e1'], properties: [], beforeBehavior: 'safe', afterBehavior: 'broken', reason: 'paired edits' },
    interaction: { editRefs: [{ fileId: 'a', editId: 'e1' }, { fileId: 'b', editId: 'e1' }] } };
  const audit = f.scope.catalog().filter(s => s.side === 'new').map(s => ({ kind: 'read', snapshotId: f.snapshot.id, sourceId: s.id, start: 1, count: 1 }));
  for (const optional of [{}, { risks: null }, { risks: [{ ...risk(), sourceIds: ['outside'] }] }]) {
    const raw = { findings: [finding], limitations: [], ...optional }, before = structuredClone(raw);
    const separated = consume(f, raw);
    const validated = validateInteractionFindings(separated.response, f.snapshot, f.group, audit, f.scope.catalog());
    assert.equal(validated.findings.length, 1); assert.equal(validated.findings[0].interaction.causality, 'unverified');
    assert.equal(validated.findings[0].anchor.snippet, file.right.text.replace(/\r\n$/, '')); assert.deepEqual(raw, before);
    assert.throws(() => validateInteractionFindings(separated.response, f.snapshot, f.group, [], f.scope.catalog()), /not read/);
  }
});

test('existing native and text contracts support optional interaction risks without adding a competing stage schema', () => {
  const f = fixture(), strategy = prepare(f), contract = modelContract(f.prepared.payload, strategy.instructions);
  assert.ok(!strategy.instructions.includes(RISK_PLAN_SCHEMA)); assert.match(contract, /interaction.editRefs/);
  const schema = modelResultTools(f.prepared.payload, strategy.instructions)[0].parameters;
  assert.ok((schema.oneOf?.[0] ?? schema).properties.risks);
  assert.match(INTERACTION_RISK_INSTRUCTIONS, /at least two distinct files/);
});
