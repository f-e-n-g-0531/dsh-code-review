import test from 'node:test';
import assert from 'node:assert/strict';
import { useResource as before } from '../evaluation/lifecycle/before.mjs';
import { useResource as after } from '../evaluation/lifecycle/after.mjs';
import { useResource as guarded } from '../evaluation/lifecycle/guarded.mjs';

async function observe(implementation, fails) {
  let acquired = 0, closed = 0;
  const error = new Error('work rejected');
  let result, thrown;
  try {
    result = await implementation(async () => {
      acquired++;
      return { close: async () => { closed++; } };
    }, async () => { if (fails) throw error; return 42; });
  } catch (e) { thrown = e; }
  return { acquired, closed, result, thrown, error };
}
test('synthetic lifecycle regression: rejection leaks only in changed implementation', async () => {
  for (const [implementation, expectedClosed] of [[before, 1], [after, 0], [guarded, 1]]) {
    const result = await observe(implementation, true);
    assert.equal(result.acquired, 1);
    assert.equal(result.closed, expectedClosed);
    assert.equal(result.thrown, result.error);
  }
});
test('synthetic lifecycle control: successful work releases all variants', async () => {
  for (const implementation of [before, after, guarded]) {
    const result = await observe(implementation, false);
    assert.equal(result.acquired, 1); assert.equal(result.closed, 1);
    assert.equal(result.result, 42); assert.equal(result.thrown, undefined);
  }
});
