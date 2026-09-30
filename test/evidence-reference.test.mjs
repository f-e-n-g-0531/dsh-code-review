import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotReader } from '../src/snapshot-reader.mjs';
import { validateEvidenceReference } from '../src/evidence-reference.mjs';
function fixture() {
  const reader = createSnapshotReader('snap', [{ id: 's1', text: 'old\r\nnew' }, { id: 's2', text: '' }]);
  const { endOfSource, ...ref } = reader.read({ id: 's1', start: 1, count: 2 });
  return { reader, ref };
}
test('exact references preserve bytes and never certify causality', () => {
  const { reader, ref } = fixture();
  const result = validateEvidenceReference(ref, reader.read);
  assert.equal(result.causality, 'unverified');
  assert.equal(result.text, 'old\r\nnew');
  assert.equal(reader.usage().calls, 2);
});
test('forged identities hashes text and clamped EOF ranges are rejected', () => {
  for (const change of [{ snapshotId: 'other' }, { sourceId: 'secret' }, { sourceId: 's2' }, { hash: '0'.repeat(64) }, { text: 'old\nnew' }, { count: 3 }, { start: 3 }]) {
    const { reader, ref } = fixture();
    assert.throws(() => validateEvidenceReference({ ...ref, ...change }, reader.read));
  }
});
test('malformed references fail before reading; shared budget exhaustion propagates', () => {
  const { ref } = fixture();
  for (const change of [{ extra: true }, { count: 0 }, { count: 201 }, { start: 1.5 }, { text: '' }, { hash: 'bad' }]) {
    assert.throws(() => validateEvidenceReference({ ...ref, ...change }, () => assert.fail('unexpected read')));
  }
  const reader = createSnapshotReader('snap', [{ id: 's1', text: 'old\r\nnew' }], { maxCalls: 1 });
  validateEvidenceReference(ref, reader.read);
  assert.throws(() => validateEvidenceReference(ref, reader.read), /budget/);
});
