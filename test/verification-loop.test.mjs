import test from 'node:test';
import assert from 'node:assert/strict';
import { verificationLoop } from '../src/verification-loop.mjs';
import { createSnapshotReader } from '../src/snapshot-reader.mjs';
const scope = () => ({ ...createSnapshotReader('snap', [{ id: 's1', text: 'guard();' }]), catalog: () => [{ id: 's1' }] });
test('verification retrieves approved evidence and preserves refutation', async () => {
  const s = scope(); let calls = 0;
  const result = await verificationLoop(async request => {
    assert.match(request.instructions, /verdicts/);
    assert.ok(!request.instructions.includes('最终返回findings和limitations'));
    const input = JSON.parse(request.input);
    assert.equal(input.candidates[0].candidateId, 'c1');
    if (!input.retrieved.length) return { requests: [{ kind: 'read', id: 's1', start: 1, count: 1 }] };
    const { endOfSource, ...ref } = input.retrieved[0].result;
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
    const { endOfSource, ...ref } = input.retrieved[0].result;
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
