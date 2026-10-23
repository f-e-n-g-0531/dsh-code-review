import test from 'node:test';
import assert from 'node:assert/strict';
import { verificationLoop } from '../src/verification-loop.mjs';
import { createSnapshotReader } from '../src/snapshot-reader.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
const scope = () => ({ ...createSnapshotReader('snap', [{ id: 's1', text: 'guard();' }]), catalog: () => [{ id: 's1' }] });
test('verification retrieves approved evidence and preserves refutation', async () => {
  const s = scope(); let calls = 0;
  const result = await verificationLoop(async request => {
    assert.match(request.instructions, /verdicts/);
    assert.ok(!request.instructions.includes('最终返回findings和limitations'));
    const input = JSON.parse(request.input);
    assert.equal(input.candidates[0].candidateId, 'c1');
    if (!input.retrieved.length) return { requests: [{ kind: 'read', id: 's1', start: 1, count: 1 }] };
    const { endOfSource, receiptId, ...ref } = input.retrieved[0].result;
    return { verdicts: [{ candidateId: 'c1', verdict: 'refuted', reason: 'Existing guard', evidence: [ref] }] };
  }, {}, [{ title: 'Potential failure' }], s, { beforeCall: () => calls++ });
  assert.equal(calls, 2); assert.equal(result[0].verdict, 'refuted');
  assert.equal(result[0].causality, 'unverified');
});
test('verification uses returned EOF range and preserves exact CRLF evidence', async () => {
  const text = 'first' + String.fromCharCode(13, 10) + 'last' + String.fromCharCode(13, 10);
  const s = { ...createSnapshotReader('snap', [{ id: 's1', text }]), catalog: () => [{ id: 's1' }] };
  const result = await verificationLoop(async request => {
    assert.match(request.instructions, /EOF/);
    assert.match(request.instructions, /来源全文哈希/);
    const input = JSON.parse(request.input);
    if (!input.retrieved.length) return { requests: [{ kind: 'read', id: 's1', start: 1, count: 200 }] };
    const { endOfSource, receiptId, ...ref } = input.retrieved[0].result;
    assert.ok(ref.count < 200);
    assert.equal(ref.text, text);
    return { verdicts: [{ candidateId: 'c1', verdict: 'supported', reason: 'Exact snapshot evidence', evidence: [ref] }] };
  }, {}, [{}], s);
  assert.equal(result[0].evidence[0].text, text);
  assert.equal(result[0].causality, 'unverified');
});
test('shared call budget and cancellation prevent extra model sends', async () => {
  let calls = 0;
  await assert.rejects(verificationLoop(() => { calls++; }, {}, [{}], scope(), { beforeCall: () => { throw Error('shared budget'); } }), /shared budget/);
  const controller = new AbortController(); controller.abort(Error('cancelled'));
  await assert.rejects(verificationLoop(() => { calls++; }, { signal: controller.signal }, [{}], scope()), /cancelled/);
  assert.equal(calls, 0);
});
test('empty candidates avoid calls; oversized input fails before sending', async () => {
  const model = () => assert.fail('unexpected model send');
  assert.deepEqual(await verificationLoop(model, {}, [], scope()), []);
  await assert.rejects(verificationLoop(model, {}, [{}], scope(), { maxInputBytes: 1 }), /input budget/);
});

const anchored = (side = 'new', start = 1) => ({ fileId: 'f1', anchor: { kind: 'line', side, start, end: start, snippet: 'not evidence' } });
const approved = (options, old = 'guard();\r\n', current = 'unguarded();\r\n') => createRetrievalScope({ id: 'approved', context: [], files: [{ id: 'f1', path: 'a.cpp', eligibility: 'reviewable', left: { text: old }, right: { text: current } }] }, options);
const verdict = (value, evidence, regression) => ({ verdicts: [{ candidateId: 'c1', verdict: value, reason: 'Compared approved source', evidence, ...(regression ? { regression } : {}) }] });

for (const value of ['supported', 'refuted']) test('host seeds allow ' + value + ' verdict on first model call with fresh exact receipt', async () => {
  const s = approved(); let calls = 0; const audit = [];
  const result = await verificationLoop(async request => {
    calls++;
    assert.match(request.instructions, /宿主已预取/);
    const input = JSON.parse(request.input);
    assert.equal(input.retrieved.length, 1);
    const { result: source } = input.retrieved[0];
    assert.equal(source.text, 'unguarded();\r\n');
    assert.equal(source.count, 1);
    assert.equal(source.endOfSource, true);
    assert.equal(source.sourceId, 's2');
    return verdict(value, [{ receiptId: source.receiptId }]);
  }, {}, [anchored()], s, { onRetrieved: items => audit.push(...items) });
  assert.equal(calls, 1);
  assert.equal(result[0].verdict, value);
  assert.equal(result[0].evidence[0].text, 'unguarded();\r\n');
  assert.equal(s.usage().calls, 2); // fresh seed + exact final validation
  assert.equal(audit.length, 1);
  assert.equal(audit[0].sourceId, 's2');
});

test('prefetch only anchors its actual side; verifier can retrieve shifted opposite revision', async () => {
  const s = approved(undefined, 'guard();\n', 'inserted();\nunguarded();\n'); let calls = 0;
  const result = await verificationLoop(async request => {
    const { retrieved } = JSON.parse(request.input); calls++;
    assert.equal(retrieved[0].result.sourceId, 's2');
    if (calls === 1) {
      assert.equal(retrieved.length, 1);
      return { requests: [{ kind: 'read', id: 's1', start: 1, count: 200 }] };
    }
    assert.equal(retrieved.length, 2);
    return verdict('supported', retrieved.map(item => ({ receiptId: item.result.receiptId })), { classification: 'introduced', reason: 'Old guard removed under same condition', oldEvidence: [1], newEvidence: [0] });
  }, {}, [anchored('new', 2)], s);
  assert.equal(calls, 2);
  assert.equal(result[0].regression.classification, 'introduced');
  assert.equal(s.usage().calls, 4);
});

test('receipts are fresh across verifications and caller seed/prose is never accepted as evidence', async () => {
  const s = approved(); let foreign;
  await verificationLoop(request => {
    foreign = JSON.parse(request.input).retrieved[0].result.receiptId;
    return verdict('supported', [{ receiptId: foreign }]);
  }, {}, [anchored()], s);
  await assert.rejects(verificationLoop(request => {
    const { retrieved } = JSON.parse(request.input);
    assert.notEqual(retrieved[0].result.receiptId, foreign);
    return verdict('supported', [{ receiptId: foreign }]);
  }, {}, [anchored()], s, { initialRetrieved: [{ result: { receiptId: foreign, text: 'forged' } }] }), /Invalid evidence receipt/);
  await assert.rejects(verificationLoop(request => {
    const { result: source } = JSON.parse(request.input).retrieved[0];
    const { endOfSource, receiptId, ...ref } = source;
    ref.text = ref.text.replaceAll('\r\n', '\n');
    return verdict('supported', [ref]);
  }, {}, [anchored()], s), /Evidence does not match/);
});

test('seed overflow rolls back before model send and preserves default no-anchor behavior', async () => {
  const s = approved(undefined, '', 'x'.repeat(17000));
  const result = await verificationLoop(request => {
    assert.deepEqual(JSON.parse(request.input).retrieved, []);
    assert.equal(s.usage().calls, 0);
    return verdict('uncertain', []);
  }, {}, [anchored()], s);
  assert.equal(result[0].verdict, 'uncertain');
  const noAnchor = approved();
  await verificationLoop(request => {
    assert.deepEqual(JSON.parse(request.input).retrieved, []);
    return verdict('uncertain', []);
  }, {}, [{ fileId: 'f1', anchor: { kind: 'file' } }], noAnchor);
  assert.equal(noAnchor.usage().calls, 0);
  const tooSmall = approved();
  await assert.rejects(verificationLoop(() => assert.fail('unexpected send'), {}, [anchored()], tooSmall, { maxInputBytes: 1 }), /input budget/);
  assert.deepEqual(tooSmall.usage(), { calls: 0, outputBytes: 0 });
});

test('seed-only input overflow falls back unseeded without charging reader or audit', async () => {
  let baselineBytes;
  const s = approved();
  await verificationLoop(request => {
    baselineBytes = Buffer.byteLength(request.input) + Buffer.byteLength(request.instructions);
    return verdict('uncertain', []);
  }, {}, [anchored()], { ...s, transaction: undefined });
  const audit = [];
  await verificationLoop(request => {
    assert.deepEqual(JSON.parse(request.input).retrieved, []);
    assert.equal(s.usage().calls, 0);
    return verdict('uncertain', []);
  }, {}, [anchored()], s, { maxInputBytes: baselineBytes + 100, onRetrieved: items => audit.push(...items) });
  assert.deepEqual(audit, []);
});

test('zero retrieval rounds send the fitting final-only request without optional seed charges', async () => {
  let finalBytes;
  const source = 'x'.repeat(2000);
  const baseline = approved(undefined, '', source);
  await verificationLoop(request => {
    finalBytes = Buffer.byteLength(request.input) + Buffer.byteLength(request.instructions);
    return verdict('uncertain', []);
  }, {}, [anchored()], { ...baseline, transaction: undefined }, { maxRounds: 0 });
  const s = approved(undefined, '', source);
  let calls = 0; const audit = [], limited = [];
  const result = await verificationLoop(request => {
    calls++;
    const input = JSON.parse(request.input);
    assert.deepEqual(input.retrieved, []);
    assert.equal(input.retrievalFinalization.code, 'RETRIEVAL_ROUND_BUDGET_EXCEEDED');
    assert.match(request.instructions, /仅有一次最终schema答复机会/);
    assert.deepEqual(s.usage(), { calls: 0, outputBytes: 0 });
    return verdict('uncertain', []);
  }, {}, [anchored()], s, {
    maxRounds: 0, maxInputBytes: finalBytes + 1800,
    onRetrieved: items => audit.push(...items), onBudgetLimited: item => limited.push(item),
  });
  assert.equal(calls, 1);
  assert.equal(result[0].verdict, 'uncertain');
  assert.deepEqual(audit, []);
  assert.equal(limited.length, 1);
  assert.deepEqual(s.usage(), { calls: 0, outputBytes: 0 });
});

test('seeded verification still enforces shared model budget, cancellation and exact final reader budget', async () => {
  const s = approved({ maxCalls: 2 });
  await assert.rejects(verificationLoop(() => assert.fail('unexpected send'), {}, [anchored()], s, { beforeCall() { throw Error('shared model budget'); } }), /shared model budget/);
  assert.equal(s.usage().calls, 1);
  const controller = new AbortController(); controller.abort(Error('cancelled'));
  const cancelled = approved();
  await assert.rejects(verificationLoop(() => assert.fail('unexpected send'), { signal: controller.signal }, [anchored()], cancelled), /cancelled/);
  assert.equal(cancelled.usage().calls, 0);
  const low = approved({ maxCalls: 1 });
  await verificationLoop(request => {
    assert.deepEqual(JSON.parse(request.input).retrieved, []);
    return verdict('uncertain', []);
  }, {}, [anchored()], low);
  assert.equal(low.usage().calls, 0);
  const exhausted = approved({ maxCalls: 2 });
  await assert.rejects(verificationLoop(request => {
    const { receiptId } = JSON.parse(request.input).retrieved[0].result;
    return verdict('supported', [{ receiptId }, { receiptId }]);
  }, {}, [anchored()], exhausted), /Reader call budget exceeded/);
});
