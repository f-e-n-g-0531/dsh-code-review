import test from 'node:test';
import assert from 'node:assert/strict';
import { runCounterVerification } from '../src/counter-verification.mjs';
import { verificationLoop } from '../src/verification-loop.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';

const candidate = { fileId: 'f1', severity: 'high', title: 'Guard removed', anchor: { kind: 'line', side: 'new', start: 1, end: 1, snippet: 'unsafe();' } };
const scope = () => createRetrievalScope({ id: 's', context: [], files: [{ id: 'f1', path: 'a.js', eligibility: 'reviewable', left: { text: 'guard();' }, right: { text: 'unsafe();' } }] });
function response(input, value = 'supported', classification = 'introduced') {
  const refs = input.retrieved.map(item => ({ receiptId: item.result.receiptId }));
  return { verdicts: input.candidates.map(row => ({ candidateId: row.candidateId, verdict: value, reason: 'Fresh approved source comparison', evidence: refs,
    regression: { classification, reason: 'Both source sides compared', oldEvidence: [1], newEvidence: [0] } })) };
}
function supporting(s, inspect = () => {}, value = 'supported', classification = 'introduced') {
  return request => {
    const input = JSON.parse(request.input); inspect(request, input);
    if (input.retrieved.length < 2) return { requests: [{ kind: 'read', id: s.catalog().find(row => row.side === 'old').id, start: 1, count: 1 }] };
    return response(input, value, classification);
  };
}
async function setup() {
  const s = scope();
  const baseline = await verificationLoop(supporting(s), { input: '{"snapshotId":"s"}' }, [candidate], s);
  return { s, baseline, request: { input: '{"snapshotId":"s"}' } };
}
test('opt-in only, strict high/critical eligibility, no mutation or uncertain upgrade', async () => {
  const { s, baseline, request } = await setup();
  const never = () => assert.fail('unexpected model call');
  assert.deepEqual(await runCounterVerification(never, request, [candidate], baseline, s), baseline);
  for (const severity of ['low', 'medium', 'unknown']) assert.deepEqual(await runCounterVerification(never, request, [{ ...candidate, severity }], baseline, s, { enabled: true }), baseline);
  for (const verdict of ['uncertain', 'refuted']) {
    const original = [{ ...baseline[0], verdict }];
    assert.deepEqual(await runCounterVerification(never, request, [candidate], original, s, { enabled: true }), original);
  }
  const invalid = [{ ...baseline[0], evidence: [{ status: 'invented' }] }];
  assert.deepEqual(await runCounterVerification(never, request, [candidate], invalid, s, { enabled: true }), invalid);
});
test('fresh independent receipts, focus, shared calls and stripped baseline fields', async () => {
  const { s, baseline, request } = await setup(); let calls = 0;
  const before = structuredClone(baseline), original = { ...candidate, verification: baseline[0], counterVerification: { secret: 'old conclusion' } };
  const out = await runCounterVerification(supporting(s, (wire, input) => {
    assert.match(wire.instructions, /独立反证复核/);
    assert.equal(input.candidates[0].finding.verification, undefined);
    assert.equal(input.candidates[0].finding.counterVerification, undefined);
    assert.equal(input.candidates[0].finding.title, candidate.title);
  }), request, [original], baseline, s, { enabled: true, beforeCall: () => calls++ });
  assert.equal(calls, 2); assert.equal(out[0].verdict, 'supported');
  assert.equal(out[0].counterVerification.status, 'completed');
  assert.equal(out[0].counterVerification.result.evidence[0].status, 'references-validated');
  assert.deepEqual(baseline, before); assert.deepEqual(original.verification, before[0]);
});
for (const [verdict, classification] of [['refuted', 'introduced'], ['uncertain', 'introduced'], ['supported', 'preexisting']]) test('disagreement conservatively downgrades ' + verdict + '/' + classification, async () => {
  const { s, baseline, request } = await setup();
  const out = await runCounterVerification(supporting(s, undefined, verdict, classification), request, [candidate], baseline, s, { enabled: true });
  assert.equal(out[0].verdict, 'uncertain'); assert.equal(out[0].regression.classification, 'uncertain');
  assert.deepEqual(out[0].evidence, baseline[0].evidence);
  assert.deepEqual(out[0].counterVerification.baselineResult, baseline[0]);
  assert.equal(out[0].counterVerification.result.verdict, verdict);
});
test('failure and shared call exhaustion downgrade without retry or echoing exception source', async () => {
  const { s, baseline, request } = await setup(); let calls = 0;
  const out = await runCounterVerification(() => { calls++; throw new Error('PRIVATE_SOURCE'); }, request, [candidate], baseline, s, { enabled: true, correctProtocol: true });
  assert.equal(calls, 1); assert.equal(out[0].verdict, 'uncertain'); assert.equal(out[0].counterVerification.status, 'incomplete');
  assert.ok(!JSON.stringify(out).includes('PRIVATE_SOURCE'));
  const exhausted = await runCounterVerification(() => assert.fail('budget allowed send'), request, [candidate], baseline, s, { enabled: true, beforeCall: () => { throw new Error('shared exhausted'); } });
  assert.equal(exhausted[0].counterVerification.status, 'incomplete');
});
test('fresh receipt table rejects baseline receipt replay', async () => {
  const s = scope(); let receipt;
  const baseline = await verificationLoop(request => { const input = JSON.parse(request.input); receipt = input.retrieved[0].result.receiptId; return { verdicts: [{ candidateId: 'c1', verdict: 'supported', reason: 'Primary source', evidence: [{ receiptId: receipt }] }] }; }, {}, [candidate], s);
  const out = await runCounterVerification(() => ({ verdicts: [{ candidateId: 'c1', verdict: 'supported', reason: 'Stale borrowed receipt', evidence: [{ receiptId: receipt }] }] }), {}, [candidate], baseline, s, { enabled: true });
  assert.equal(out[0].counterVerification.status, 'incomplete'); assert.equal(out[0].verdict, 'uncertain');
});
test('abort and artifact/checkpoint fatal preserve exact original errors', async () => {
  const { s, baseline, request } = await setup();
  for (const code of ['MODEL_ARTIFACT_FAILED', 'CHECKPOINT_FAILED', 'RESUME_CHECKPOINT_FAILED']) {
    const error = Object.assign(new Error('fatal'), { code });
    await assert.rejects(runCounterVerification(() => { throw error; }, request, [candidate], baseline, s, { enabled: true }), value => value === error);
  }
  const checkpoint = new Error('uncoded persistence fatal');
  await assert.rejects(runCounterVerification(() => { throw checkpoint; }, request, [candidate], baseline, s, { enabled: true, isFatalError: value => value === checkpoint }), value => value === checkpoint);
  const controller = new AbortController(), reason = new Error('cancelled');
  await assert.rejects(runCounterVerification(() => { controller.abort(reason); throw new Error('secondary'); }, { ...request, signal: controller.signal }, [candidate], baseline, s, { enabled: true }), value => value === reason);
});
test('mixed batch retains input alignment and supports critical preexisting agreement only', async () => {
  const { s, baseline, request } = await setup();
  const prior = await verificationLoop(supporting(s, undefined, 'supported', 'preexisting'), request, [candidate], s);
  const rows = [{ ...candidate, severity: 'low' }, { ...candidate, severity: 'critical' }, { ...candidate, severity: 'high' }];
  const input = [baseline[0], prior[0], { ...baseline[0], verdict: 'uncertain' }];
  const out = await runCounterVerification(supporting(s, (_wire, payload) => assert.equal(payload.candidates.length, 1), 'supported', 'preexisting'), request, rows, input, s, { enabled: true });
  assert.deepEqual(out[0], input[0]); assert.deepEqual(out[2], input[2]);
  assert.equal(out[1].verdict, 'supported'); assert.equal(out[1].regression.classification, 'preexisting');
  assert.deepEqual(out[1].counterVerification.baselineResult, prior[0]);
});
test('supported without a validated comparison cannot become introduced by agreement', async () => {
  const { s, baseline, request } = await setup();
  const unassessed = [{ ...baseline[0], regression: { classification: 'unassessed', causality: 'unverified' } }];
  const out = await runCounterVerification(supporting(s), request, [candidate], unassessed, s, { enabled: true });
  assert.equal(out[0].verdict, 'uncertain'); assert.equal(out[0].regression.classification, 'uncertain');
  assert.equal(out[0].counterVerification.result.verdict, 'supported');
});
test('incomplete protocol is not silently corrected even if caller enables corrections', async () => {
  const { s, baseline, request } = await setup(); let calls = 0;
  const out = await runCounterVerification(() => { calls++; return { verdicts: [] }; }, request, [candidate], baseline, s, { enabled: true, correctProtocol: true });
  assert.equal(calls, 1); assert.equal(out[0].counterVerification.status, 'incomplete');
});
test('invalid lengths and >50 candidates fail before any model send', async () => {
  const { s, baseline, request } = await setup(); const never = () => assert.fail('send');
  await assert.rejects(runCounterVerification(never, request, [candidate], [], s, { enabled: true }), /Invalid/);
  await assert.rejects(runCounterVerification(never, request, Array(51).fill(candidate), Array(51).fill(baseline[0]), s, { enabled: true }), /Invalid/);
  await assert.rejects(runCounterVerification(never, request, [candidate], baseline, s, { enabled: 'yes' }), /policy/);
});
