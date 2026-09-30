import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoader as before } from '../evaluation/stale-result/before.mjs';
import { createLoader as after } from '../evaluation/stale-result/after.mjs';
import { createLoader as guarded } from '../evaluation/stale-result/guarded.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
test('synthetic stale-result regression: older completion overwrites newer selection only after guard removal', async () => {
  for (const [create, expected] of [[before, 'new'], [after, 'old'], [guarded, 'new']]) {
    const old = deferred(), recent = deferred(), requested = [];
    const loader = create(key => { requested.push(key); return key === 'old' ? old.promise : recent.promise; });
    const first = loader.load('old'), second = loader.load('new');
    assert.deepEqual(requested, ['old', 'new']);
    recent.resolve('new'); await second;
    assert.equal(loader.value, 'new');
    old.resolve('old'); await first;
    assert.equal(loader.value, expected);
  }
});
test('synthetic stale-result control: serial loads succeed for every variant', async () => {
  for (const create of [before, after, guarded]) {
    const loader = create(async key => key);
    await loader.load('old'); assert.equal(loader.value, 'old');
    await loader.load('new'); assert.equal(loader.value, 'new');
  }
});
