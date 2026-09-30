import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCandidateVerification as validate } from '../src/candidate-verification.mjs';
import { createSnapshotReader } from '../src/snapshot-reader.mjs';
const uncertain = id => ({ candidateId: id, verdict: 'uncertain', reason: 'Not enough context', evidence: [] });
test('complete uncertain verdicts retain host order and unverified causality', () => {
  const result = validate({ verdicts: [uncertain('c2'), uncertain('c1')] }, ['c1', 'c2'], () => assert.fail());
  assert.deepEqual(result.map(x => x.candidateId), ['c1', 'c2']);
  assert.ok(result.every(x => x.causality === 'unverified'));
});
test('missing duplicate invented candidates and unsupported claims fail before reads', () => {
  for (const verdicts of [[], [uncertain('other')], [uncertain('c1'), uncertain('c1')], [{ ...uncertain('c1'), verdict: 'supported' }], [{ ...uncertain('c1'), verdict: 'refuted' }], [{ ...uncertain('c1'), reason: ' ' }]]) {
    assert.throws(() => validate({ verdicts }, ['c1'], () => assert.fail('Unexpected read')));
  }
});
test('supported and refuted verdicts require exact approved evidence without proving causality', () => {
  const reader = createSnapshotReader('snap', [{ id: 's1', text: 'guard();' }]);
  const { endOfSource, ...ref } = reader.read({ id: 's1', start: 1, count: 1 });
  for (const verdict of ['supported', 'refuted']) {
    const result = validate({ verdicts: [{ candidateId: 'c1', verdict, reason: 'Check guard', evidence: [ref] }] }, ['c1'], reader.read);
    assert.equal(result[0].verdict, verdict);
    assert.equal(result[0].causality, 'unverified');
  }
});
