import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseRiskStrategy } from '../src/risk-strategy.mjs';
import { changeMap } from '../src/change-map.mjs';
import { changeWindows } from '../src/change-windows.mjs';
import { sourceSegments } from '../src/source-segments.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { REVIEW_INSTRUCTIONS, INLINE_RISK_INSTRUCTIONS } from '../src/prompts.mjs';
import { initialInputBudget } from '../src/input-budget.mjs';
import { hash } from '../src/content.mjs';
import { preparePrimaryInput } from '../src/primary-input.mjs';
import { buildCoveragePlan } from '../src/coverage-plan.mjs';

function fixture(before, after) {
  const file = { id: 'f', path: 'main.js', eligibility: 'reviewable', leftExists: true, rightExists: true,
    left: { text: before, hash: hash(before), encoding: 'utf-8' }, right: { text: after, hash: hash(after), encoding: 'utf-8' } };
  const input = { id: 's', files: [file], context: [] }, changes = changeMap(before, after);
  const windows = sourceSegments(changeWindows(file, changes));
  const payload = JSON.stringify({ snapshotId: 's', file: { ...file, left: { ...file.left, text: undefined }, right: { ...file.right, text: undefined } },
    changes, windows, sourceMode: 'change-windows', contextMode: 'approved-retrieval', context: [], contextCatalog: [] });
  const prepared = { changes, payload, metadata: { sourceMode: 'change-windows', windowIds: windows.map(w => w.id), windowBlocked: [] } };
  const options = { instructions: REVIEW_INSTRUCTIONS, maxInputBytes: 96000, riskPlanningMode: 'auto', enableRiskPlanning: true, scope: createRetrievalScope(input) };
  return { input, file, prepared, options };
}
const choose = f => chooseRiskStrategy(f.input, f.file, f.prepared, f.options);
const mutatePayload = (f, mutate) => { const p = JSON.parse(f.prepared.payload); mutate(p); f.prepared.payload = JSON.stringify(p); };
const multiline = () => {
  const before = Array.from({ length: 100 }, (_, i) => 'line' + i + '\r\n'), after = [...before];
  after[5] = 'changed first\r\n'; after[90] = 'changed second\r\n';
  return fixture(before.join(''), after.join(''));
};

test('all exact multi-hunk CRLF windows can inline as a single envelope or single explicit batch', () => {
  for (const explicitBatch of [false, true]) {
    const f = multiline();
    assert.equal(f.prepared.changes.edits.length, 2);
    if (explicitBatch) f.prepared.batches = [{ payload: f.prepared.payload, windowIds: [...f.prepared.metadata.windowIds] }];
    const before = structuredClone(f.prepared), result = choose(f);
    assert.equal(result.mode, 'inline');
    assert.equal(result.instructions, REVIEW_INSTRUCTIONS + '\n' + INLINE_RISK_INSTRUCTIONS);
    assert.deepEqual(result.budget, initialInputBudget({ instructions: result.instructions, input: f.prepared.payload }, f.options.scope, 96000));
    assert.deepEqual(f.prepared, before); assert.equal(f.options.scope.usage().calls, 0);
  }
});

test('segmented windows repeating the same editId require all canonical segments and both sides', () => {
  const f = fixture('old\r\n'.repeat(250), 'new\r\n'.repeat(250));
  const p = JSON.parse(f.prepared.payload);
  assert.equal(f.prepared.changes.edits.length, 1); assert.equal(p.windows.length, 3);
  assert.equal(choose(f).mode, 'inline');
  mutatePayload(f, p => p.windows.pop());
  f.prepared.metadata.windowIds.pop();
  assert.equal(choose(f).fallbackReason, 'incomplete-edit-scope');
});

for (const [name, before, after] of [
  ['empty old', '', 'new\r\n'], ['empty new', 'old\r\n', ''],
  ['insert boundary', 'a\r\nb\r\n', 'a\r\ninsert\r\nb\r\n'],
  ['delete boundary', 'a\r\nremove\r\nb\r\n', 'a\r\nb\r\n'],
]) test('exact zero-count and EOF boundaries preserve inline scope: ' + name, () => {
  const f = fixture(before, after); assert.equal(choose(f).mode, 'inline');
  mutatePayload(f, p => { p.windows[0].old.start++; });
  assert.equal(choose(f).fallbackReason, 'incomplete-edit-scope');
});

test('identities hashes original text and complete edit metadata cannot be replaced by same editIds', () => {
  const mutations = [
    p => { p.windows[0].new.text = 'forged'; }, p => { p.windows[0].old.text = p.windows[0].new.text; },
    p => { p.windows[0].editIds = ['foreign']; }, p => { p.windows[0].id = 'forged'; },
    p => { p.windows[0].new.count--; }, p => { p.changes.edits.pop(); },
    p => { p.changes.precision = 'envelope'; }, p => { p.file.id = 'other'; },
    p => { p.file.left.hash = p.file.right.hash; }, p => { p.file.path = 'other.js'; },
    p => { p.file.right.text = 'nonapproved body'; }, p => { p.windows.push(p.windows[0]); },
    p => { p.snapshotId = 'foreign-snapshot'; },
  ];
  for (const mutate of mutations) { const f = multiline(); mutatePayload(f, mutate); assert.equal(choose(f).fallbackReason, 'incomplete-edit-scope'); }
  for (const change of [f => { f.prepared.metadata.windowIds.pop(); }, f => { f.prepared.metadata.windowBlocked = ['w1']; },
    f => { f.prepared.changes.edits[0].old.count++; }, f => { f.file.left.text += 'source changed'; },
    f => { delete f.file.left.text; }, f => { f.prepared.synthesis = {}; },
    f => { f.prepared.batches = [{ payload: f.prepared.payload, windowIds: ['wrong'] }]; },
    f => { f.prepared.batches = [{ payload: '{}', windowIds: f.prepared.metadata.windowIds }]; },
    f => { f.prepared.batches = []; }, f => { f.prepared.metadata.batchCount = 2; },
  ]) { const f = multiline(); change(f); assert.equal(choose(f).fallbackReason, 'incomplete-edit-scope'); }
});

test('fallback reasons are bounded and no unsafe mode changes project separate or multiple batches', () => {
  const cases = [
    [f => { f.options.riskPlanningMode = 'separate'; }, 'mode-notauto'],
    [f => { f.options.enableRiskPlanning = false; }, 'disabled'],
    [f => { f.options.skipSmallRiskPlans = true; }, 'smallchange'],
    [f => { f.input.projectScope = {}; }, 'project'],
    [f => { f.options.round = 2; }, 'laterround'],
    [f => { f.prepared.batches = [{}, {}]; }, 'multi-batch'],
    [f => { f.prepared.payload = '{invalid'; }, 'incomplete-edit-scope'],
    [f => { f.options.maxInputBytes = 1; }, 'input-budget'],
  ];
  for (const [change, expected] of cases) { const f = multiline(); change(f); const result = choose(f); assert.notEqual(result.mode, 'inline'); assert.equal(result.fallbackReason, expected); }
});

test('ordinary production preparation yields an authentic complete window scope with no new reads', () => {
  const lines = Array.from({ length: 200 }, (_, i) => 'line' + i + 'x'.repeat(60) + '\r\n'), after = [...lines];
  after[10] = 'changed first\r\n'; after[180] = 'changed second\r\n';
  const f = fixture(lines.join(''), after.join(''));
  f.options.maxInputBytes = 14000;
  const prepared = preparePrimaryInput(f.input, f.file, { ...f.options, riskPlanningMode: 'separate' });
  assert.equal(prepared.metadata.sourceMode, 'change-windows');
  assert.equal(prepared.batches, undefined);
  const strategy = chooseRiskStrategy(f.input, f.file, prepared, f.options);
  assert.equal(strategy.mode, 'inline');
  const auto = preparePrimaryInput(f.input, f.file, f.options);
  assert.equal(auto.inlineRisk, true);
  assert.equal(auto.instructions, strategy.instructions);
  assert.equal(auto.payload, prepared.payload);
  assert.equal(auto.budget.bytes, strategy.budget.bytes);
  const preview = buildCoveragePlan(f.input, f.options);
  assert.equal(preview.items[0].riskPlanning.mode, 'inline');
  assert.equal(preview.minimumCalls, 1);
  assert.equal(preview.items[0].initialInputBytes, auto.budget.bytes);
  assert.equal(f.options.scope.usage().calls, 0);
});

test('window combined envelope budget is inclusive and contexts do not silently disable inline', () => {
  const f = multiline(), exact = choose(f).budget.bytes;
  f.options.maxInputBytes = exact; assert.equal(choose(f).mode, 'inline');
  f.options.maxInputBytes--; assert.equal(choose(f).fallbackReason, 'input-budget');
  const full = multiline();
  full.prepared = { payload: JSON.stringify({ snapshotId: 's', file: full.file, changes: full.prepared.changes,
    contextMode: 'approved-retrieval', context: [], contextCatalog: [{ id: 's3', path: 'deferred.js', side: 'context' }] }), metadata: { contextMode: 'approved-retrieval' } };
  assert.equal(choose(full).mode, 'inline');
  assert.ok(INLINE_RISK_INSTRUCTIONS.includes('every exact edit'));
  assert.ok(Buffer.byteLength(INLINE_RISK_INSTRUCTIONS) <= 1024);
});
