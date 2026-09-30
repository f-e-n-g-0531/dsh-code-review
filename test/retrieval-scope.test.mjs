import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
const snapshot = () => ({ id: 'snap', files: [{ id: 'f', path: 'a', eligibility: 'reviewable', left: { text: 'old' }, right: { text: 'new' } }, { id: 'secret', path: 'secret', eligibility: 'excluded', right: { text: 'password' } }], context: [{ path: 'helper', text: 'definition' }] });
test('scope exposes only reviewable sides and explicit context with opaque identifiers', () => {
  const source = snapshot(), scope = createRetrievalScope(source);
  assert.equal(scope.catalog().length, 3);
  assert.deepEqual(scope.search({ query: 'password' }).matches, []);
  assert.throws(() => scope.read({ id: 'secret', start: 1, count: 1 }), /authorized/);
  source.files[0].right.text = 'mutated';
  assert.equal(scope.read({ id: 's2', start: 1, count: 1 }).text, 'new');
  const catalog = scope.catalog(); catalog[0].path = 'changed';
  assert.equal(scope.catalog()[0].path, 'a');
});
test('context cannot bypass exclusion or provide conflicting text', () => {
  for (const context of [[{ path: 'secret', text: 'password' }], [{ path: 'a', text: 'other' }]]) assert.throws(() => createRetrievalScope({ ...snapshot(), context }), /conflicts/);
  const source = snapshot(); source.context = [{ path: 'a', text: 'new' }];
  assert.equal(createRetrievalScope(source).catalog().length, 2);
  source.files[0].rightExists = false;
  assert.throws(() => createRetrievalScope(source), /conflicts/);
});
