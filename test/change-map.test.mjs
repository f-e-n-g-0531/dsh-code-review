import test from 'node:test';
import assert from 'node:assert/strict';
import { changeMap } from '../src/change-map.mjs';
import { buildHunks } from '../src/hunks.mjs';
test('compact changes reference every edit exactly once without duplicated source', () => {
  const a = 'a'.repeat(10000) + '\n', b = 'b'.repeat(10000) + '\n';
  const compact = changeMap(a, b);
  assert.ok(JSON.stringify(compact).length < 500);
  assert.ok(JSON.stringify(buildHunks(a, b)).length > 40000);
  assert.deepEqual(compact.hunks.flatMap(h => h.editIds), compact.edits.map(e => e.id));
  assert.deepEqual(compact.edits[0].old, { start: 1, count: 1 });
});
test('compact changes preserve empty and limited states', () => {
  assert.equal(changeMap('', '').status, 'unchanged');
  const limited = changeMap('a', 'b', { maxCells: 1 });
  assert.equal(limited.status, 'limited');
  assert.equal(limited.envelope.precision, 'envelope');
  assert.deepEqual(limited.hunks, []);
});
