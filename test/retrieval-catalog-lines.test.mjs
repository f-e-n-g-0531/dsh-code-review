import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';

const snapshot = (left, right = left) => ({ id: 'approved-snapshot', files: [{
  id: 'f1', path: 'source.mjs', eligibility: 'reviewable',
  left: { text: left }, right: { text: right },
}], context: [] });
const hash = text => createHash('sha256').update(text).digest('hex');

for (const [name, text, expected] of [
  ['empty', '', 0], ['single unterminated', 'alpha', 1],
  ['single LF terminated', 'alpha\n', 1], ['single CRLF terminated', 'alpha\r\n', 1],
  ['empty LF line', '\n', 1], ['empty CRLF line', '\r\n', 1],
  ['two trailing LF', 'alpha\n\n', 2], ['two trailing CRLF', 'alpha\r\n\r\n', 2],
  ['mixed terminated and unterminated', 'alpha\r\nbeta\ngamma', 3],
  ['unicode', '中😀\n末尾\n', 2], ['lone CR is not a separator', 'alpha\rbeta', 1],
]) {
  test('catalog lineCount matches snapshot reader: ' + name, () => {
    const scope = createRetrievalScope(snapshot(text));
    assert.deepEqual(scope.catalog().map(s => s.lineCount), [expected, expected]);
    const source = scope.catalog()[1];
    if (expected) {
      const result = scope.read({ id: source.id, start: 1, count: 200 });
      assert.equal(result.count, expected);
      assert.equal(result.text, text);
      assert.equal(result.hash, hash(text));
      assert.equal(result.snapshotId, 'approved-snapshot');
      assert.equal(result.sourceId, source.id);
      assert.equal(result.endOfSource, true);
      assert.equal(scope.read({ id: source.id, start: expected, count: 1 }).count, 1);
    }
    assert.throws(() => scope.read({ id: source.id, start: expected + 1, count: 1 }), /outside source/);
  });
}

test('old new and historical context have independent counts without changing authority or body', () => {
  const input = snapshot('old\n', 'new1\r\nnew2\r\nnew3');
  input.history = { base: 'baseline', target: 'target' };
  input.context = [{ path: 'context.mjs', text: '', oldText: 'context old\r\nsecond\r\n', revision: 'target', oldRevision: 'baseline' }];
  input.files.push({ id: 'blocked', path: 'blocked.mjs', eligibility: 'blocked', left: { text: 'blocked' }, right: { text: 'blocked' } });
  input.files.push({ id: 'excluded', path: 'excluded.mjs', eligibility: 'excluded', left: { text: 'excluded' }, right: { text: 'excluded' } });
  const scope = createRetrievalScope(input), catalog = scope.catalog();
  assert.deepEqual(catalog, [
    { id: 's1', path: 'source.mjs', side: 'old', lineCount: 1, fileId: 'f1' },
    { id: 's2', path: 'source.mjs', side: 'new', lineCount: 3, fileId: 'f1' },
    { id: 's3', path: 'context.mjs', side: 'context', lineCount: 0 },
    { id: 's4', path: 'context.mjs', side: 'context-old', lineCount: 2 },
  ]);
  assert.deepEqual(scope.usage(), { calls: 0, outputBytes: 0 });
  assert.throws(() => scope.read({ id: 's1', start: 2, count: 1 }), /outside source/);
  assert.equal(scope.read({ id: 's2', start: 3, count: 1 }).text, 'new3');
  assert.throws(() => scope.read({ id: 's3', start: 1, count: 1 }), /outside source/);
  assert.equal(scope.read({ id: 's4', start: 2, count: 1 }).text, 'second\r\n');
  assert.throws(() => scope.read({ id: 'blocked', start: 1, count: 1 }), /not authorized/);
  assert.deepEqual(scope.search({ query: 'excluded' }).matches, []);
  assert.ok(catalog.every(s => !Object.hasOwn(s, 'text') && !Object.hasOwn(s, 'hash')));
  input.files[0].right.text = ''; input.context[0].oldText = '';
  catalog[1].lineCount = 900; catalog[1].id = 'forged';
  assert.equal(scope.catalog()[1].lineCount, 3);
  assert.equal(scope.read({ id: 's2', start: 3, count: 1 }).hash, hash('new1\r\nnew2\r\nnew3'));
  assert.equal(scope.catalog()[3].lineCount, 2);
});

test('catalog bounds do not relax reader numeric limits or silently clamp source identities', () => {
  const scope = createRetrievalScope(snapshot('x\n'.repeat(201)));
  assert.equal(scope.catalog()[0].lineCount, 201);
  assert.equal(scope.read({ id: 's1', start: 201, count: 1 }).text, 'x\n');
  for (const request of [
    { id: 's1', start: 0, count: 1 }, { id: 's1', start: '1', count: 1 },
    { id: 's1', start: 1.5, count: 1 }, { id: 's1', start: 1, count: 0 },
    { id: 's1', start: 1, count: 201 }, { id: 'source.mjs', start: 1, count: 1 },
  ]) assert.throws(() => scope.read(request));
});
