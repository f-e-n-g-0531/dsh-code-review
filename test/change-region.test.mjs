import test from 'node:test';
import assert from 'node:assert/strict';
import { changeRegion } from '../src/change-region.mjs';
test('change envelope preserves insertion deletion and replacement coordinates', () => {
  assert.deepEqual(changeRegion('a\nb\n', 'a\nx\nb\n'), { status: 'changed', precision: 'envelope', old: { start: 2, count: 0 }, new: { start: 2, count: 1 } });
  assert.deepEqual(changeRegion('x', ''), { status: 'changed', precision: 'envelope', old: { start: 1, count: 1 }, new: { start: 1, count: 0 } });
  assert.equal(changeRegion('', '').status, 'unchanged');
  assert.equal(changeRegion('a\n', 'a').status, 'changed');
  assert.equal(changeRegion('a\r\n', 'a\n').status, 'changed');
});
test('limits are explicit and checked before line allocation', () => {
  assert.equal(changeRegion('abc', 'def', { maxBytes: 5 }).status, 'limited');
  assert.throws(() => changeRegion('', '', { maxBytes: NaN }), /limit/);
});
