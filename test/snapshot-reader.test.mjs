import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotReader } from '../src/snapshot-reader.mjs';
test('reader returns immutable snapshot text and source provenance', () => {
  const entries = [{ id: 'f:new', text: 'one\r\ntwo\nthree' }];
  const reader = createSnapshotReader('s1', entries);
  entries[0].text = 'changed';
  const result = reader.read({ id: 'f:new', start: 2, count: 100 });
  assert.equal(result.text, 'two\nthree');
  assert.equal(result.count, 2);
  assert.equal(result.snapshotId, 's1');
  assert.match(result.hash, /^[0-9a-f]{64}$/);
  result.text = 'mutated';
  assert.equal(reader.read({ id: 'f:new', start: 1, count: 1 }).text, 'one\r\n');
});
test('reader rejects unknown sources malformed ranges duplicates and oversize output', () => {
  const reader = createSnapshotReader('s', [{ id: 'f', text: 'a\n' }]);
  assert.throws(() => reader.read({ id: '../secret', start: 1, count: 1 }), /authorized/);
  for (const range of [{ start: 0, count: 1 }, { start: 1, count: 201 }, { start: 2, count: 1 }, { start: NaN, count: 1 }]) assert.throws(() => reader.read({ id: 'f', ...range }));
  assert.throws(() => createSnapshotReader('s', [{ id: 'f', text: '' }, { id: 'f', text: '' }]), /entry/);
  assert.throws(() => createSnapshotReader('s', [{ id: 'f', text: 'abc' }], { maxBytes: 2 }), /budget/);
  const large = createSnapshotReader('s', [{ id: 'f', text: 'x'.repeat(65537) }]);
  assert.throws(() => large.read({ id: 'f', start: 1, count: 1 }), /output budget/);
});
