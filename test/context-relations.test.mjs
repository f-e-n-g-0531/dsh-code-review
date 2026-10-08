import test from 'node:test';
import assert from 'node:assert/strict';
import { inferContextRelations } from '../src/context-relations.mjs';
const primary = { id: 'p', path: 'src/main.js', eligibility: 'reviewable', left: { text: '' }, right: { text: "import './guard.js';" } };
test('explicit approved context imports retain path direction without adding coverage', () => {
  const context = [{ path: 'src/guard.js', text: "import './main.js';" }];
  const result = inferContextRelations({ files: [primary], context }, primary);
  assert.equal(result.length, 2);
  assert.ok(result.some(r => r.side === 'new' && r.toPath === 'src/guard.js'));
  assert.ok(result.some(r => r.side === 'context' && r.toPath === primary.path));
  assert.equal(context.length, 1);
});
test('selected alternative extension remains an ambiguity competitor', () => {
  const p = { ...primary, right: { text: "import './guard';" } };
  const other = { id: 'b', path: 'src/guard.ts', eligibility: 'reviewable' };
  assert.deepEqual(inferContextRelations({ files: [p, other], context: [{ path: 'src/guard.js', text: '' }] }, p), []);
});
test('selected blocked path cannot be reintroduced as explicit context', () => {
  const blocked = { id: 'b', path: 'src/guard.js', eligibility: 'blocked' };
  assert.deepEqual(inferContextRelations({ files: [primary, blocked], context: [{ path: blocked.path, text: '' }] }, primary), []);
});
