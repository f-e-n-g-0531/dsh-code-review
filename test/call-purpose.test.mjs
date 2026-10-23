import test from 'node:test';
import assert from 'node:assert/strict';
import { retrievalLoop, retrievalRequest } from '../src/retrieval-loop.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { createDshModel } from '../src/dsh-model.mjs';
import { modelContract } from '../src/model-contract.mjs';
import { reviewDiagnostics, diagnosticsMarkdown } from '../src/review-diagnostics.mjs';
const final = { findings: [], limitations: [] };
const request = { input: '{}', instructions: 'review' };
const read = start => ({ kind: 'read', id: 's1', start, count: 1 });
const scope = (text = 'one\ntwo\n', options) => createRetrievalScope({ id: 's', files: [], context: [{ path: 'a.js', text }] }, options);
const scripted = (responses, events = []) => {
  let calls = 0;
  const model = createDshModel({ async *stream() {
    const text = responses[calls++];
    yield { type: 'text-delta', text };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } }, { provider: 'offline', model: 'test' }, { correctJson: true });
  return { model: r => model({ ...r, onModelEvent: e => events.push(e) }), calls: () => calls };
};

test('retrieval model purpose follows actual initial followup and budget-final calls', async () => {
  const purposes = [];
  await retrievalLoop(async r => { purposes.push(r.callPurpose); return purposes.length === 1 ? { requests: [read(1)] } : final; }, request, scope());
  assert.deepEqual(purposes, ['primary-initial', 'retrieval-followup']);
  purposes.length = 0;
  await retrievalLoop(async r => { purposes.push(r.callPurpose); return purposes.length === 1 ? { requests: [read(1)] } : final; }, request, scope(undefined, { maxCalls: 1 }));
  assert.deepEqual(purposes, ['primary-initial', 'budget-finalization']);
});

test('allowExhaustedInitial keeps full-body initial answer possible but read requests still finalize', async () => {
  for (const needsRead of [false, true]) {
    const reader = scope(undefined, { maxCalls: 1 }); reader.read(read(1));
    const purposes = []; let limited = 0;
    await retrievalLoop(async r => {
      purposes.push(r.callPurpose);
      const p = JSON.parse(r.input);
      if (purposes.length === 1) {
        assert.equal(p.retrievalFinalization, undefined);
        return needsRead ? { requests: [read(1)] } : final;
      }
      assert.equal(p.retrievalFinalization.code, 'READER_CALL_BUDGET_EXCEEDED');
      return final;
    }, request, reader, { allowExhaustedInitial: true, onBudgetLimited: () => limited++ });
    assert.deepEqual(purposes, needsRead ? ['primary-initial', 'budget-finalization'] : ['primary-initial']);
    assert.equal(limited, needsRead ? 1 : 0);
    assert.equal(reader.usage().calls, 1);
  }
});

test('adapter emits allowlisted purpose only and labels every JSON correction separately', async () => {
  const events = [], runner = scripted(['{bad', '{}'], events);
  assert.equal(await runner.model({ ...request, callPurpose: 'retrieval-followup' }), '{}');
  assert.deepEqual(events.map(e => [e.action, e.callPurpose]), [['model-start', 'retrieval-followup'], ['model-end', 'retrieval-followup'], ['model-start', 'json-correction'], ['model-end', 'json-correction']]);
  const unknown = [], legacy = scripted(['{}'], unknown);
  await legacy.model({ ...request, callPurpose: 'PRIVATE_SOURCE' });
  assert.equal(Object.hasOwn(unknown[0], 'callPurpose'), false);
  assert.ok(!JSON.stringify(unknown).includes('PRIVATE_SOURCE'));
});

test('optional wire budget includes model contract and final newline with exact UTF8 boundary', async () => {
  const r = { instructions: '审查', input: JSON.stringify({ file: { id: 'f' } }) };
  const bytes = Buffer.byteLength(r.instructions + '\n' + modelContract(r.input, r.instructions)) + Buffer.byteLength(r.input);
  const exact = scripted(['{}']); await exact.model({ ...r, maxInputBytes: bytes }); assert.equal(exact.calls(), 1);
  const events = [], rejected = scripted(['{}'], events);
  await assert.rejects(rejected.model({ ...r, maxInputBytes: bytes - 1 }), e => e.code === 'MODEL_INPUT_BUDGET_EXCEEDED' && e.diagnostic.wireInputBytes === bytes);
  assert.equal(rejected.calls(), 0); assert.deepEqual(events, []);
  const legacy = scripted(['{}']); await legacy.model(r); assert.equal(legacy.calls(), 1);
});

test('correction suffix cannot oversend or reserve a correction that exceeds optional wire budget', async () => {
  const events = [], runner = scripted(['{bad', '{}'], events); let reserved = 0;
  const bytes = Buffer.byteLength(request.instructions + '\n') + Buffer.byteLength(request.input);
  await assert.rejects(runner.model({ ...request, maxInputBytes: bytes, onProtocolCorrection: () => reserved++ }), { code: 'MODEL_INPUT_BUDGET_EXCEEDED' });
  assert.equal(runner.calls(), 1); assert.equal(reserved, 0);
  assert.deepEqual(events.map(e => e.action), ['model-start', 'model-end']);
});

test('oversized withheld retrieval results never enter delivery audit', async () => {
  const reader = scope('x'.repeat(8000)); const audit = []; let calls = 0;
  const base = retrievalRequest(request, reader);
  const maxInputBytes = Buffer.byteLength(base.input) + Buffer.byteLength(base.instructions) + 600;
  await retrievalLoop(async r => {
    if (++calls === 1) return { requests: [read(1)] };
    assert.equal(JSON.parse(r.input).retrieved[0].result.omitted, true);
    return final;
  }, request, reader, { correctProtocol: true, maxInputBytes, onRetrieved: rows => audit.push(...rows) });
  assert.equal(reader.usage().calls, 1); assert.deepEqual(audit, []);
});

test('same-batch evicted evidence is not audited but earlier delivered evidence remains stable', async () => {
  for (const sameBatch of [true, false]) {
    const reader = scope('a'.repeat(1500) + '\n' + 'b'.repeat(1500)); const audit = []; let calls = 0;
    const base = retrievalRequest(request, reader);
    const maxInputBytes = Buffer.byteLength(base.input) + Buffer.byteLength(base.instructions) + 2300;
    await retrievalLoop(async r => {
      calls++;
      if (calls === 1) return { requests: sameBatch ? [read(1), read(2)] : [read(1)] };
      if (!sameBatch && calls === 2) return { requests: [read(2)] };
      assert.equal(JSON.parse(r.input).retrieved.length, 1);
      assert.equal(JSON.parse(r.input).retrieved[0].request.start, 2);
      return final;
    }, request, reader, { correctProtocol: true, maxInputBytes, onRetrieved: rows => audit.push(...rows) });
    assert.deepEqual(audit.map(row => row.start), sameBatch ? [2] : [1, 2]);
  }
});

test('diagnostics purposes and reader budgets are numeric allowlists, absent is unavailable', () => {
  const d = reviewDiagnostics({ files: [
    { modelCallPurposes: { 'primary-initial': 2, 'json-correction': 1, PRIVATE: 100 } },
    { modelCallPurposes: { 'primary-initial': 3, 'verification': -1 } },
  ], readerBudget: { calls: 7, maxCalls: 50, outputBytes: 123, maxOutputBytes: 200, remainingCalls: 43, remainingOutputBytes: 77, maxResultBytes: 64, source: 'PRIVATE', error: 'PRIVATE' } });
  assert.equal(d.schemaVersion, 2);
  assert.deepEqual(d.modelCallPurposes, [{ purpose: 'primary-initial', calls: 5 }, { purpose: 'json-correction', calls: 1 }, { purpose: 'verification', calls: null }]);
  assert.equal(d.readerBudget.calls, 7);
  assert.ok(!JSON.stringify(d).includes('PRIVATE'));
  const absent = reviewDiagnostics({});
  assert.deepEqual(absent.modelCallPurposes, []);
  assert.ok(Object.values(absent.readerBudget).every(value => value === null));
});

test('allowExhaustedInitial does not grant a read round when maxRounds is zero', async () => {
  const reader = scope(); const purposes = [];
  await retrievalLoop(async r => {
    purposes.push(r.callPurpose);
    return purposes.length === 1 ? { requests: [read(1)] } : final;
  }, request, reader, { allowExhaustedInitial: true, maxRounds: 0 });
  assert.deepEqual(purposes, ['primary-initial', 'budget-finalization']);
  assert.equal(reader.usage().calls, 0);
});

test('budget veto and cancellation cannot publish unadmitted evidence audit', async () => {
  const reader = scope(); let reservations = 0; const audit = [];
  const veto = new Error('stop second model reservation');
  await assert.rejects(retrievalLoop(async () => ({ requests: [read(1)] }), request, reader, {
    beforeCall() { if (++reservations === 2) throw veto; }, onRetrieved: rows => audit.push(...rows),
  }), error => error === veto);
  assert.deepEqual(audit, []);
});

test('optional wire limit and purpose cannot be changed by lifecycle callback mutation', async () => {
  const events = []; let calls = 0, reserved = 0;
  const model = createDshModel({ async *stream() {
    calls++; yield { type: 'text-delta', text: '{bad' }; yield { type: 'finish', reason: { kind: 'stop' } };
  } }, { provider: 'offline', model: 'test' }, { correctJson: true });
  const r = { ...request, callPurpose: 'risk-planning', maxInputBytes: Buffer.byteLength(request.instructions + '\n' + request.input), onProtocolCorrection: () => reserved++ };
  r.onModelEvent = e => { events.push(e); r.maxInputBytes = 999999; r.callPurpose = 'PRIVATE'; };
  await assert.rejects(model(r), { code: 'MODEL_INPUT_BUDGET_EXCEEDED' });
  assert.equal(calls, 1); assert.equal(reserved, 0);
  assert.ok(events.every(e => e.callPurpose === 'risk-planning'));
});

test('cancelled request preserves cancellation identity before optional wire validation', async () => {
  const controller = new AbortController(), reason = new Error('cancel'); controller.abort(reason);
  const runner = scripted(['{}']);
  await assert.rejects(runner.model({ ...request, signal: controller.signal, maxInputBytes: 1 }), e => e === reason);
  assert.equal(runner.calls(), 0);
});

test('seeded first request is initial purpose and audit publishes only once', async () => {
  const reader = scope(), seeded = { request: read(1), result: reader.read(read(1)) };
  const purposes = [], audit = [];
  await retrievalLoop(async r => {
    purposes.push(r.callPurpose);
    return purposes.length === 1 ? { requests: [read(2)] } : final;
  }, request, reader, { initialRetrieved: [seeded], onRetrieved: rows => audit.push(...rows) });
  assert.deepEqual(purposes, ['primary-initial', 'retrieval-followup']);
  assert.deepEqual(audit.map(row => row.start), [1, 2]);
});

test('cancelled followup cannot publish undelivered reader output', async () => {
  const controller = new AbortController(), reason = new Error('stop followup');
  const reader = scope(), audit = []; let calls = 0;
  await assert.rejects(retrievalLoop(async () => {
    calls++; return { requests: [read(1)] };
  }, { ...request, signal: controller.signal, onProtocolEvent() { controller.abort(reason); } }, reader, {
    maxRounds: 1,
    onRetrieved: rows => audit.push(...rows),
  }), e => e === reason);
  assert.equal(calls, 1); assert.deepEqual(audit, []);
});
