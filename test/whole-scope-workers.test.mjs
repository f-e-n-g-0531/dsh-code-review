import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { runWholeScopeWorkers, createCheckpointQueue } from '../src/whole-scope-workers.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const same = expected => actual => actual === expected;

for (const concurrency of [1, 2, 4]) {
  test('bounded concurrency ' + concurrency + ' preserves input order under reversed completion', async () => {
    const items = Array.from({ length: concurrency * 2 }, (_, i) => i + 10);
    const gates = items.map(deferred), started = [], finished = [];
    let active = 0, peak = 0;
    const result = runWholeScopeWorkers(items, async (item, index) => {
      started.push(index);
      peak = Math.max(peak, ++active);
      await gates[index].promise;
      --active;
      finished.push(index);
      return item * 2;
    }, { concurrency });
    assert.deepEqual(started, items.slice(0, concurrency).map((_, i) => i));
    for (let batch = 0; batch < items.length; batch += concurrency) {
      for (let index = batch + concurrency - 1; index >= batch; --index) {
        gates[index].resolve();
        await turn();
      }
    }
    assert.deepEqual(await result, items.map(item => item * 2));
    assert.equal(active, 0);
    assert.equal(peak, concurrency);
    assert.deepEqual(finished.slice(0, concurrency), Array.from({ length: concurrency }, (_, i) => concurrency - 1 - i));
  });
}

test('default concurrency is two; invalid bounds reject before admission', async () => {
  const gate = deferred(), started = [];
  const work = runWholeScopeWorkers([0, 1, 2], async item => { started.push(item); await gate.promise; });
  assert.deepEqual(started, [0, 1]);
  gate.resolve();
  await work;
  for (const concurrency of [0, -1, 5, 1.5, NaN, Infinity, '2', null]) {
    await assert.rejects(runWholeScopeWorkers([0], () => assert.fail('admitted invalid work'), { concurrency }), RangeError);
  }
  assert.deepEqual(await runWholeScopeWorkers([], () => assert.fail('empty')), []);
});

test('fatal notifies outer abort immediately, stops admission, joins peers and preserves first error', async () => {
  const first = new Error('first'), later = new Error('later'), controller = new AbortController();
  const gates = [deferred(), deferred()], notified = deferred(), started = [], calls = [];
  let settled = false;
  const work = runWholeScopeWorkers([0, 1, 2, 3], async item => {
    started.push(item);
    return gates[item].promise;
  }, { signal: controller.signal, onFatal(error) {
    calls.push(error);
    controller.abort(error);
    notified.resolve();
  } });
  work.then(() => { settled = true; }, () => { settled = true; });
  gates[0].reject(first);
  await notified.promise;
  assert.equal(controller.signal.reason, first);
  assert.equal(settled, false);
  assert.deepEqual(started, [0, 1]);
  gates[1].reject(later);
  await assert.rejects(work, same(first));
  assert.deepEqual(calls, [first]);
});

test('fatal without an abort signal still stops admission and joins active work', async () => {
  const gates = [deferred(), deferred()], first = new Error('fatal without signal');
  const started = [];
  let settled = false;
  const work = runWholeScopeWorkers([0, 1, 2], item => {
    started.push(item);
    return gates[item].promise;
  });
  work.then(() => { settled = true; }, () => { settled = true; });
  gates[0].reject(first);
  await turn();
  assert.deepEqual(started, [0, 1]);
  assert.equal(settled, false);
  gates[1].resolve();
  await assert.rejects(work, same(first));
  assert.deepEqual(started, [0, 1]);
});

test('synchronous failure and throwing fatal notification cannot replace original error', async () => {
  const first = new Error('run'), callback = new Error('notification');
  const started = [];
  await assert.rejects(runWholeScopeWorkers([0, 1], item => {
    started.push(item);
    throw first;
  }, { onFatal() { throw callback; } }), same(first));
  assert.deepEqual(started, [0]);
});

test('cancellation stops admissions but rejects exact reason only after active work joins', async () => {
  const controller = new AbortController(), reason = { cancelled: true };
  const gates = [deferred(), deferred()], started = [];
  let settled = false, fatal = 0;
  const work = runWholeScopeWorkers([0, 1, 2], async item => {
    started.push(item);
    await gates[item].promise;
  }, { signal: controller.signal, onFatal() { ++fatal; } });
  work.then(() => { settled = true; }, () => { settled = true; });
  controller.abort(reason);
  gates[0].resolve();
  await turn();
  assert.equal(settled, false);
  assert.deepEqual(started, [0, 1]);
  gates[1].resolve();
  await assert.rejects(work, same(reason));
  assert.equal(fatal, 0);
  await assert.rejects(runWholeScopeWorkers([0], () => assert.fail('pre-aborted admission'), { signal: controller.signal }), same(reason));
  await assert.rejects(runWholeScopeWorkers([], () => {}, { signal: controller.signal }), same(reason));
});

test('checkpoints clone at enqueue and await FIFO saves without overlap', async () => {
  const gates = [deferred(), deferred()], seen = [];
  let active = 0, peak = 0, drained = false;
  const queue = createCheckpointQueue(async value => {
    const index = seen.length;
    seen.push(value);
    peak = Math.max(peak, ++active);
    await gates[index].promise;
    --active;
  });
  const value = { nested: { count: 1 }, values: [1] };
  const first = queue.enqueue(value);
  value.nested.count = 2;
  value.values.push(2);
  const second = queue.enqueue(value);
  value.nested.count = 3;
  const drain = queue.drain().then(() => { drained = true; });
  await turn();
  assert.deepEqual(seen, [{ nested: { count: 1 }, values: [1] }]);
  assert.equal(drained, false);
  gates[0].resolve();
  await first;
  await turn();
  assert.deepEqual(seen[1], { nested: { count: 2 }, values: [1, 2] });
  assert.equal(drained, false);
  gates[1].resolve();
  await Promise.all([second, drain]);
  assert.equal(peak, 1);
});

test('drain includes checkpoints enqueued during an active save', async () => {
  const gate = deferred(), late = deferred(), seen = [];
  const queue = createCheckpointQueue(async value => {
    seen.push(value);
    await (value === 1 ? gate.promise : late.promise);
  });
  queue.enqueue(1);
  let drained = false;
  const drain = queue.drain().then(() => { drained = true; });
  await turn();
  queue.enqueue(2);
  gate.resolve();
  await turn();
  assert.deepEqual(seen, [1, 2]);
  assert.equal(drained, false);
  late.resolve();
  await drain;
});

test('checkpoint failure is sticky, notifies once, skips subsequent saves and drain rejects original', async () => {
  const first = new Error('save failed'), gate = deferred(), calls = [], saves = [];
  const queue = createCheckpointQueue(async value => {
    saves.push(value);
    await gate.promise;
    throw first;
  }, error => { calls.push(error); throw new Error('notification failed'); });
  const one = queue.enqueue(1), two = queue.enqueue(2);
  gate.resolve();
  await assert.rejects(one, same(first));
  await assert.rejects(two, same(first));
  await assert.rejects(queue.enqueue(3), same(first));
  await assert.rejects(queue.drain(), same(first));
  await assert.rejects(queue.drain(), same(first));
  assert.deepEqual(saves, [1]);
  assert.deepEqual(calls, [first]);
});

test('ignored enqueue rejection stays handled and is still surfaced by drain', async () => {
  const first = new Error('ignored enqueue');
  const queue = createCheckpointQueue(() => { throw first; });
  queue.enqueue(1);
  queue.enqueue(2);
  await turn();
  queue.enqueue(3);
  await turn();
  await assert.rejects(queue.drain(), same(first));
});

test('clone failure remains FIFO and sticky; null save is a no-op without cloning', async () => {
  const gate = deferred(), seen = [], fatal = [];
  const queue = createCheckpointQueue(async value => { seen.push(value); await gate.promise; }, error => fatal.push(error));
  const first = queue.enqueue(1), bad = queue.enqueue(() => {}), skipped = queue.enqueue(3);
  await turn();
  assert.deepEqual(seen, [1]);
  assert.deepEqual(fatal, []);
  gate.resolve();
  await first;
  const error = await bad.catch(error => error);
  assert.equal(error.name, 'DataCloneError');
  await assert.rejects(skipped, same(error));
  await assert.rejects(queue.drain(), same(error));
  assert.deepEqual(fatal, [error]);
  for (const save of [null, undefined]) {
    const noop = createCheckpointQueue(save, () => assert.fail('no-op fatal'));
    await noop.enqueue(() => {});
    await noop.drain();
  }
});
