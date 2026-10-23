import test from 'node:test';
import assert from 'node:assert/strict';
import { modelWireBudget, configureWireBudget, nativeWireEnabled } from '../src/model-wire-budget.mjs';
import { initialInputBudget } from '../src/input-budget.mjs';
import { createDshModel } from '../src/dsh-model.mjs';
import { modelContract } from '../src/model-contract.mjs';
import { modelResultTools, NATIVE_RESULT_INSTRUCTIONS } from '../src/model-tools.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { retrievalRequest } from '../src/retrieval-loop.mjs';
import { preparePrimaryInput } from '../src/primary-input.mjs';
import { REVIEW_INSTRUCTIONS } from '../src/review.mjs';
import { RISK_PLAN_INSTRUCTIONS } from '../src/risk-plan.mjs';

const request = { input: JSON.stringify({ snapshotId: 's', file: { id: 'f' } }), instructions: '审查', nativeOutputTools: true };
const wireBytes = wire => Buffer.byteLength(wire.system) + Buffer.byteLength(wire.messages[0].content[0].text) + (wire.tools.length ? Buffer.byteLength(JSON.stringify(wire.tools)) : 0);
const fixture = () => ({ id: 's', files: [{ id: 'f', path: 'a.js', eligibility: 'reviewable', properties: [], left: { text: 'before' }, right: { text: 'after' } }], context: [] });

test('exact native planning budget equals actual transmitted adapter fields at UTF8 boundary', async () => {
  const expected = modelWireBudget(request, 100000).bytes;
  let sends = 0;
  const model = createDshModel({ async *stream(wire) {
    sends++;
    assert.equal(wireBytes(wire), expected);
    yield { type: 'text-delta', text: '{"findings":[],"limitations":[]}' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } }, { provider: 'offline', model: 'fake' }, { useNativeTools: true });
  await model({ ...request, maxInputBytes: expected });
  assert.equal(sends, 1);
  assert.equal(modelWireBudget(request, expected).fits, true);
  assert.equal(modelWireBudget(request, expected - 1).fits, false);
  await assert.rejects(model({ ...request, maxInputBytes: expected - 1 }), { code: 'MODEL_INPUT_BUDGET_EXCEEDED' });
  assert.equal(sends, 1, 'oversized request never reaches stream');
});

test('all native stages and finalization measure actual stage contracts without hidden reserve', () => {
  const stages = [request,
    { ...request, input: '{"candidates":[]}' },
    { ...request, input: '{"files":[]}', instructions: '返回{groups:数组}' },
    { ...request, instructions: RISK_PLAN_INSTRUCTIONS },
    { ...request, input: '{"sourceMode":"group-primary","files":[]}' },
    { ...request, input: '{"sourceMode":"file-interaction","files":[]}' },
    { ...request, input: '{"file":{"id":"f"},"retrievalFinalization":{"code":"READER_CALL_BUDGET_EXCEEDED"}}' },
    { ...request, input: '{}' },
  ];
  for (const r of stages) {
    const tools = modelResultTools(r.input, r.instructions);
    const expected = Buffer.byteLength(r.input) + Buffer.byteLength(r.instructions + '\n' + modelContract(r.input, r.instructions) + (tools.length ? NATIVE_RESULT_INSTRUCTIONS : '')) + (tools.length ? Buffer.byteLength(JSON.stringify(tools)) : 0);
    assert.deepEqual(modelWireBudget(r, expected), { bytes: expected, maxBytes: expected, fits: true });
  }
});

test('scope opt-in is isolated and immutable, with legacy initial-budget bytes unchanged by default', () => {
  const a = createRetrievalScope(fixture()), b = createRetrievalScope(fixture());
  const r = { instructions: request.instructions, input: request.input };
  const before = initialInputBudget(r, a, 100000);
  assert.equal(configureWireBudget(a, { nativeOutputTools: true }), a);
  assert.equal(configureWireBudget(a, { nativeOutputTools: true }), a);
  assert.equal(nativeWireEnabled(r, a), true);
  assert.equal(nativeWireEnabled(r, b), false);
  const actual = retrievalRequest(r, a);
  assert.deepEqual(initialInputBudget(r, a, 100000), modelWireBudget({ ...actual, nativeOutputTools: true }, 100000));
  assert.deepEqual(initialInputBudget(r, b, 100000), before);
  assert.deepEqual(initialInputBudget({ ...r, nativeOutputTools: false }, a, 100000), before);
  assert.throws(() => configureWireBudget(a, { nativeOutputTools: false }), /configured/);
  assert.equal(modelWireBudget({ ...r, nativeOutputTools: false }, 100000).bytes, Buffer.byteLength(r.input) + Buffer.byteLength(r.instructions + '\n' + modelContract(r.input, r.instructions)));
});

test('explicit native request measures no-scope input too while unconfigured legacy does not gain a contract', () => {
  assert.deepEqual(initialInputBudget(request, undefined, 100000), modelWireBudget(request, 100000));
  const legacy = { instructions: request.instructions, input: request.input };
  assert.equal(initialInputBudget(legacy, undefined, 100000).bytes, Buffer.byteLength(legacy.input) + Buffer.byteLength(legacy.instructions));
});

test('near-cap primary is blocked during preparation before any model call instead of adapter-only rejection', () => {
  const input = fixture(), file = input.files[0];
  file.left.text = 'x'.repeat(3000); file.right.text = 'y'.repeat(3000);
  const legacyScope = createRetrievalScope(input), nativeScope = configureWireBudget(createRetrievalScope(input), { nativeOutputTools: true });
  const common = { instructions: REVIEW_INSTRUCTIONS, maxInputBytes: 100000 };
  const legacy = preparePrimaryInput(input, file, { ...common, scope: legacyScope });
  const native = preparePrimaryInput(input, file, { ...common, scope: nativeScope });
  assert.equal(legacy.budget.fits, true);
  assert.equal(native.budget.fits, true);
  assert.ok(native.budget.bytes > legacy.budget.bytes);
  const cap = legacy.budget.bytes;
  const nativeBlocked = preparePrimaryInput(input, file, { ...common, maxInputBytes: cap, scope: nativeScope });
  assert.equal(preparePrimaryInput(input, file, { ...common, maxInputBytes: cap, scope: legacyScope }).budget.fits, true);
  assert.equal(nativeBlocked.budget.fits, false, 'one full-replacement window cannot bypass native overhead');
  assert.equal(nativeBlocked.metadata.sourceMode, undefined);
});

test('native headroom causes window fallback before sends while retaining complete edit scope', () => {
  const input = fixture(), file = input.files[0];
  const old = Array.from({ length: 100 }, (_, i) => 'line' + i + 'x'.repeat(150));
  const changed = [...old]; changed[10] = 'changed10'; changed[80] = 'changed80';
  file.left.text = old.join('\n'); file.right.text = changed.join('\n');
  const legacyScope = createRetrievalScope(input), nativeScope = configureWireBudget(createRetrievalScope(input), { nativeOutputTools: true });
  const options = { instructions: REVIEW_INSTRUCTIONS, scope: legacyScope, maxInputBytes: 100000 };
  const full = preparePrimaryInput(input, file, options);
  const cap = full.budget.bytes;
  const legacy = preparePrimaryInput(input, file, { ...options, maxInputBytes: cap });
  const native = preparePrimaryInput(input, file, { ...options, scope: nativeScope, maxInputBytes: cap });
  assert.equal(legacy.batches, undefined);
  assert.equal(native.budget.fits, true);
  assert.equal(native.metadata.sourceMode, 'change-windows');
  assert.deepEqual(native.changes.edits, legacy.changes.edits);
  assert.deepEqual([...new Set((native.batches ?? [{ payload: native.payload }]).flatMap(batch => JSON.parse(batch.payload).windows.flatMap(window => window.editIds)))], ['e1', 'e2']);
});

test('malformed wire limits flags and scopes fail without mutating request or source', () => {
  for (const max of [0, -1, NaN, Infinity, 1.5, '100']) assert.throws(() => modelWireBudget(request, max), /budget/);
  for (const r of [null, {}, { instructions: 1, input: '{}' }, { ...request, nativeOutputTools: 'true' }]) assert.throws(() => modelWireBudget(r, 10000));
  for (const scope of [null, 1, 'scope']) assert.throws(() => configureWireBudget(scope, { nativeOutputTools: true }), /scope/);
  assert.throws(() => configureWireBudget({}, {}), /boolean/);
  assert.throws(() => initialInputBudget({ ...request, nativeOutputTools: 'true' }, undefined, 10000), /boolean/);
  const before = structuredClone(request); modelWireBudget(request, 10000); assert.deepEqual(request, before);
});
