import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { retrievalLoop, retrievalRequest } from '../src/retrieval-loop.mjs';
import { createEvidenceReceipts } from '../src/evidence-receipts.mjs';
import { validateEvidenceReference } from '../src/evidence-reference.mjs';

const snapshot = () => ({ id: 'snap', files: [], context: [{ path: 'helper', text: 'one\r\ntwo\n' }] });
const scope = options => createRetrievalScope(snapshot(), options);
const request = { input: '{}', instructions: 'review' };
const read = (start = 1) => ({ kind: 'read', id: 's1', start, count: 1 });
const final = { findings: [], limitations: [] };

test('model sees exact shared remaining budgets before and after retrieval', async () => {
  const reader = scope({ maxCalls: 3, maxOutputBytes: 2048 });
  reader.find({ query: 'helper' });
  const original = reader.budget();
  let calls = 0;
  await retrievalLoop(async req => {
    const p = JSON.parse(req.input);
    assert.match(req.instructions, /retrievalBudget/);
    assert.equal(p.retrievalBudget.maxCalls, 3);
    assert.equal(p.retrievalBudget.remainingCalls, 2 - calls);
    assert.equal(p.retrievalBudget.remainingOutputBytes, reader.budget().remainingOutputBytes);
    calls++;
    return calls === 1 ? { requests: [read()] } : final;
  }, request, reader);
  assert.equal(calls, 2);
  assert.ok(reader.budget().remainingOutputBytes < original.remainingOutputBytes);
  const copy = reader.budget(); copy.remainingCalls = 100;
  assert.equal(reader.budget().remainingCalls, 1);
});

test('last reader call carries evidence into one final-only turn and marks the stage limited', async () => {
  const reader = scope({ maxCalls: 1 });
  let calls = 0, counted = 0;
  const limited = [], audit = [], events = [];
  const candidate = { title: 'must not be silently dropped' };
  const result = await retrievalLoop(async req => {
    calls++;
    if (calls === 1) return { requests: [read()] };
    const p = JSON.parse(req.input);
    assert.equal(p.retrievalBudget.remainingCalls, 0);
    assert.equal(p.retrievalFinalization.code, 'READER_CALL_BUDGET_EXCEEDED');
    assert.equal(p.retrieved[0].result.text, 'one\r\n');
    assert.match(req.instructions, /不得再返回requests/);
    return { findings: [candidate], limitations: [] };
  }, { ...request, onProtocolEvent: e => events.push(e) }, reader, {
    beforeCall: () => counted++, onBudgetLimited: x => limited.push(x), onRetrieved: r => audit.push(...r),
  });
  assert.deepEqual(result.findings, [candidate]);
  assert.equal(calls, 2); assert.equal(counted, 2);
  assert.equal(limited.length, 1); assert.equal(audit.length, 1);
  assert.equal(events[0].action, 'retrieval-budget-finalization');
  assert.equal(reader.usage().calls, 1);
});

test('an already exhausted shared scope gets only one final schema call', async () => {
  const reader = scope({ maxCalls: 1 }); reader.read(read());
  let calls = 0, limited = 0;
  await assert.rejects(retrievalLoop(async req => {
    calls++;
    assert.equal(JSON.parse(req.input).retrievalBudget.remainingCalls, 0);
    return { requests: [read()] };
  }, request, reader, { correctProtocol: true, onBudgetLimited: () => limited++ }), { code: 'RETRIEVAL_FINAL_RESPONSE_REQUIRED' });
  assert.equal(calls, 1); assert.equal(limited, 1); assert.equal(reader.usage().calls, 1);
});

test('over-budget batches are entirely withheld and never retried against the reader', async () => {
  const reader = scope({ maxCalls: 1 });
  let calls = 0;
  const audit = [];
  const result = await retrievalLoop(async req => {
    calls++;
    if (calls === 1) return { requests: [read(), read(2)] };
    assert.equal(JSON.parse(req.input).retrieved.length, 0);
    assert.equal(JSON.parse(req.input).retrievalBudget.remainingCalls, 1);
    return { ...final, limitations: ['budget prevented batch'] };
  }, request, reader, { onRetrieved: r => audit.push(...r) });
  assert.equal(calls, 2); assert.equal(reader.usage().calls, 0); assert.deepEqual(audit, []);
  assert.equal(result.limitations.length, 1);
});

test('aggregate and single-result output overruns are recovered without partial output or charges', async () => {
  for (const maxOutputBytes of [1, 300]) {
    const reader = scope({ maxOutputBytes });
    let calls = 0, limited;
    await retrievalLoop(async req => {
      calls++;
      if (calls === 1) return { requests: [read(), read(2)] };
      assert.equal(JSON.parse(req.input).retrieved.length, 0);
      return final;
    }, request, reader, { onBudgetLimited: x => { limited = x; } });
    assert.equal(limited.code, 'READER_OUTPUT_BUDGET_EXCEEDED');
    assert.deepEqual(reader.usage(), { calls: 0, outputBytes: 0 });
  }
  const reader = createRetrievalScope({ ...snapshot(), context: [{ path: 'large', text: 'x'.repeat(65537) }] });
  let calls = 0;
  await retrievalLoop(async () => ++calls === 1 ? { requests: [read()] } : final, request, reader);
  assert.equal(calls, 2); assert.deepEqual(reader.usage(), { calls: 0, outputBytes: 0 });
});

test('all dynamic ranges are checked before any reads and only one correction is allowed', async () => {
  const reader = scope(); let calls = 0;
  await assert.rejects(retrievalLoop(async () => {
    calls++;
    return { requests: [read(), read(1000)] };
  }, request, reader, { correctProtocol: true }), /outside source/);
  assert.equal(calls, 2); assert.deepEqual(reader.usage(), { calls: 0, outputBytes: 0 });
});

test('authorization and malformed filters are not reclassified as budget recovery', async () => {
  for (const operation of [{ ...read(), id: '../private' }, { kind: 'search', query: 'one', limit: 1, sourceIds: ['private'] }]) {
    const reader = scope({ maxCalls: 1 }); let calls = 0, limited = 0;
    await assert.rejects(retrievalLoop(async () => { calls++; return { requests: [read(), operation] }; }, request, reader,
      { correctProtocol: true, onBudgetLimited: () => limited++ }), /authorized/);
    assert.equal(calls, 1); assert.equal(limited, 0); assert.equal(reader.usage().calls, 0);
  }
  const reader = scope(); let calls = 0;
  await assert.rejects(retrievalLoop(async () => { calls++; return { requests: [read(), { kind: 'read', id: 's1', start: '2', count: 1 }] }; }, request, reader, { correctProtocol: true }), /Invalid read request/);
  assert.equal(calls, 2); assert.equal(reader.usage().calls, 0);
});

test('finalization does not bypass model call guard, cancellation or input capacity', async () => {
  const reader = scope({ maxCalls: 1 }); let calls = 0, counted = 0;
  await assert.rejects(retrievalLoop(async () => { calls++; return { requests: [read()] }; }, request, reader, {
    beforeCall: () => { if (++counted > 1) throw new Error('Model call budget exceeded'); },
  }), /Model call budget/);
  assert.equal(calls, 1); assert.equal(reader.usage().calls, 1);

  const controller = new AbortController(), cancelled = scope({ maxCalls: 1 }); calls = 0;
  await assert.rejects(retrievalLoop(async () => { calls++; return { requests: [read()] }; }, { ...request, signal: controller.signal }, cancelled, {
    onBudgetLimited: () => controller.abort(new Error('cancel finalization')),
  }), /cancel finalization/);
  assert.equal(calls, 1);

  const tight = scope({ maxCalls: 1 }); calls = 0;
  const envelope = retrievalRequest(request, tight);
  const maxInputBytes = Buffer.byteLength(envelope.input) + Buffer.byteLength(envelope.instructions);
  await assert.rejects(retrievalLoop(async () => { calls++; return { requests: [read()] }; }, request, tight, { maxInputBytes }), /input budget/);
  assert.equal(calls, 1);
});

test('round exhaustion reserves its existing final turn rather than granting extra retrieval', async () => {
  const reader = scope(); let calls = 0, limited = 0;
  const result = await retrievalLoop(async req => {
    calls++;
    if (calls === 1) return { requests: [read()] };
    assert.equal(JSON.parse(req.input).retrievalFinalization.code, 'RETRIEVAL_ROUND_BUDGET_EXCEEDED');
    return final;
  }, request, reader, { maxRounds: 1, onBudgetLimited: () => limited++ });
  assert.deepEqual(result, final); assert.equal(calls, 2); assert.equal(limited, 1); assert.equal(reader.usage().calls, 1);
});

test('decorated output failures roll back the whole batch and publish no audit or receipt', async () => {
  const baseline = scope();
  const first = baseline.read(read()), second = baseline.read(read(2));
  const rawBytes = Buffer.byteLength(JSON.stringify(first)) + Buffer.byteLength(JSON.stringify(second));
  const reader = scope({ maxOutputBytes: rawBytes + 70 });
  const receipts = createEvidenceReceipts(reader.read), audit = [];
  let calls = 0;
  await retrievalLoop(async req => {
    calls++;
    if (calls === 1) return { requests: [read(), read(2)] };
    assert.equal(JSON.parse(req.input).retrieved.length, 0);
    return final;
  }, request, { ...reader, read: receipts.read }, { onRetrieved: r => audit.push(...r) });
  assert.equal(calls, 2); assert.deepEqual(audit, []);
  assert.deepEqual(reader.usage(), { calls: 0, outputBytes: 0 });
});

test('strict evidence validation still rejects tampering and consumes the unchanged shared budget', async () => {
  const reader = scope({ maxCalls: 2 });
  const receipts = createEvidenceReceipts(reader.read); let reference, calls = 0;
  await retrievalLoop(async req => {
    calls++;
    if (calls === 1) return { requests: [read()] };
    const result = JSON.parse(req.input).retrieved[0].result;
    reference = receipts.resolve({ receiptId: result.receiptId });
    return { verdicts: [{ candidateId: 'c1', verdict: 'supported', reason: 'source', evidence: [{ receiptId: result.receiptId }] }] };
  }, request, { ...reader, read: receipts.read });
  assert.throws(() => validateEvidenceReference({ ...reference, text: 'forged' }, reader.read), /does not match/);
  assert.equal(reader.usage().calls, 2);
  assert.throws(() => validateEvidenceReference(reference, reader.read), { code: 'READER_CALL_BUDGET_EXCEEDED' });
});
