import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotReader } from '../src/snapshot-reader.mjs';
test('many short lines stream without inventing a terminal empty line', () => {
  const reader = createSnapshotReader('s', [{ id: 'f', text: '\n'.repeat(100000) + 'needle' }]);
  assert.equal(reader.search({ query: 'needle' }).matches[0].line, 100001);
  assert.equal(reader.read({ id: 'f', start: 100001, count: 1 }).text, 'needle');
  const end = createSnapshotReader('s', [{ id: 'f', text: 'x\n' }]);
  assert.throws(() => end.read({ id: 'f', start: 2, count: 1 }), /outside/);
  assert.equal(end.search({ query: 'x', limit: 1 }).truncated, false);
});

test('literal search shares call and serialized output budgets with reads', () => {
  const reader = createSnapshotReader('s', [{ id: 'f', text: 'a.*\na.*\n' }], { maxCalls: 2 });
  const result = reader.search({ query: '.*', limit: 1 });
  assert.equal(result.matches[0].line, 1);
  assert.equal(result.truncated, true);
  reader.read({ id: 'f', start: 1, count: 1 });
  assert.equal(reader.usage().calls, 2);
  assert.throws(() => reader.search({ query: 'a' }), /call budget/);
  const small = createSnapshotReader('s', [], { maxOutputBytes: 1 });
  assert.throws(() => small.search({ query: 'x' }), /output budget/);
});
test('cancellation prevents further reads and searches', () => {
  const controller = new AbortController();
  const reader = createSnapshotReader('s', [], { signal: controller.signal });
  controller.abort(new Error('stopped'));
  assert.throws(() => reader.search({ query: 'x' }), /stopped/);
  assert.throws(() => reader.read({ id: 'f', start: 1, count: 1 }), /stopped/);
  assert.equal(reader.usage().calls, 0);
});
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
