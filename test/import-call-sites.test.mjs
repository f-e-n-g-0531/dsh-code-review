import test from 'node:test';
import assert from 'node:assert/strict';
import { importedCallSites, indexStandaloneCalls } from '../src/import-call-sites.mjs';
import { inferImportRelations } from '../src/import-relations.mjs';
test('named aliases/default calls preserve original lines and local spellings', () => {
  const lines = ["import { run as go } from './run.js';", 'await go(input);', 'object.go();', '// go();', '"go();"'];
  assert.deepEqual(importedCallSites(lines, 1), [{ local: 'go', line: 2 }]);
  assert.deepEqual(importedCallSites(["import go from './run.js';", 'go();'], 1), [{ local: 'go', line: 2 }]);
});
test('shared single-pass index preserves results for multiple imports', () => {
  const lines = ["import { one } from './one.js';", "import { two as other } from './two.js';", 'other();', 'one();'];
  const index = indexStandaloneCalls(lines);
  assert.deepEqual(importedCallSites(lines, 1, index), importedCallSites(lines, 1));
  assert.deepEqual(importedCallSites(lines, 2, index), [{ local: 'other', line: 3 }]);
});
test('type-only namespace and string/comment arguments are not claimed calls', () => {
  for (const binding of ['type Go', '* as go', '{ type go }']) assert.deepEqual(importedCallSites(['import ' + binding + " from './run.js';", 'go();'], 1), []);
  assert.deepEqual(importedCallSites(["import go from './run.js';", "go('text');", 'go(/* comment */);'], 1), []);
});
test('call annotations are bounded and reachability is not claimed', () => {
  const lines = ["import go from './run.js';", ...Array(100).fill('go();')];
  assert.equal(importedCallSites(lines, 1).length, 20);
  const files = [{ id: 'a', path: 'a.js', eligibility: 'reviewable', left: { text: '' }, right: { text: lines.join(String.fromCharCode(10)) } }, { id: 'b', path: 'run.js', eligibility: 'reviewable', left: { text: '' }, right: { text: '' } }];
  assert.ok(inferImportRelations(files).some(e => e.reason.startsWith('imported-call-syntax:')));
});
