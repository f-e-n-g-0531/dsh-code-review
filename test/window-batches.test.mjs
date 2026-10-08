import test from 'node:test';
import assert from 'node:assert/strict';
import { planWindowBatches } from '../src/window-batches.mjs';
const windows = [1, 2, 3, 4].map(n => ({ id: 'h' + n, text: 'x'.repeat(n * 10) }));
const serialize = list => JSON.stringify({ windows: list });
const measure = payload => ({ bytes: Buffer.byteLength(payload), fits: Buffer.byteLength(payload) <= 100 });
test('batches account for JSON metadata and cover every window exactly once', () => {
  const result = planWindowBatches(windows, serialize, measure);
  const ids = [...result.batches.flatMap(b => b.windowIds), ...result.blocked.map(b => b.windowId)];
  assert.deepEqual(ids.sort(), windows.map(w => w.id));
  assert.equal(new Set(ids).size, windows.length);
  assert.equal(result.minimumCalls, result.batches.length);
  assert.ok(result.batches.every(b => b.bytes <= 100));
});
test('oversized window and batch cap remain explicit instead of silently dropping hunks', () => {
  const result = planWindowBatches([...windows, { id: 'huge', text: 'x'.repeat(1000) }], serialize, measure, { maxBatches: 1 });
  assert.ok(result.blocked.some(b => b.reason === 'batch-limit'));
  const big = planWindowBatches([{ id: 'huge', text: 'x'.repeat(1000) }], serialize, measure);
  assert.deepEqual(big.blocked, [{ windowId: 'huge', reason: 'input-budget' }]);
});
test('invalid identities and budgets fail closed', () => {
  assert.throws(() => planWindowBatches([windows[0], windows[0]], serialize, measure), /identity/);
  assert.throws(() => planWindowBatches(windows, serialize, measure, { maxBatches: 21 }), /Invalid/);
});
