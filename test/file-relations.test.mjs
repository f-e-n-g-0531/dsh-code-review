import test from 'node:test';
import assert from 'node:assert/strict';
import { inferTestRelations } from '../src/file-relations.mjs';
const f = path => ({ id: path, path, eligibility: 'reviewable' });
test('naming hints support colocated and mirrored tests without repository reads', () => {
  const files = ['src/a.ts', 'src/a.test.ts', 'src/b.js', 'test/b.spec.js', 'lib/c.mjs', 'lib/__tests__/c.mjs'].map(f);
  const edges = inferTestRelations(files);
  assert.equal(edges.length, 3);
  assert.deepEqual(edges, inferTestRelations(files.reverse()));
  assert.ok(edges.every(e => e.reason === 'implementation-test:naming'));
});
test('ambiguous missing excluded and unrelated basenames are not linked', () => {
  const files = ['a.ts', 'src/a.ts', 'test/a.ts', 'other/b.ts', 'test/b.ts', 'src/c.ts', 'test/c.ts'].map(f);
  files.find(f => f.path === 'src/c.ts').eligibility = 'excluded';
  assert.deepEqual(inferTestRelations(files), []);
  assert.throws(() => inferTestRelations([f('../a.ts')]));
  assert.throws(() => inferTestRelations([f('a.ts'), f('a.ts')]));
});
