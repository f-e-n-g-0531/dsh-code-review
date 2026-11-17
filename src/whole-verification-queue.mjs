/** An owned, bounded queue. enqueue never returns a rejecting detached promise.
 * drain joins every admitted task, including cleanup, before surfacing failure.
 * A lane prevents concurrent use of the same reader allocation.
 */
export function createWholeVerificationQueue(run, { concurrency = 2, signal, onFatal } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new RangeError('verificationConcurrency must be 1..4');
  const pending = [], active = new Set(), lanes = new Set();
  let scheduled = false, failure, failed = false;
  const fail = error => {
    if (!failed) { failed = true; failure = error; try { onFatal?.(error); } catch {} }
  };
  const pump = () => {
    scheduled = false;
    while (!failed && !signal?.aborted && active.size < concurrency) {
      const index = pending.findIndex(job => !lanes.has(job.lane));
      if (index < 0) break;
      const job = pending.splice(index, 1)[0];
      lanes.add(job.lane);
      let task;
      // Both branches settle successfully; failure is rethrown only by drain.
      task = Promise.resolve().then(() => { signal?.throwIfAborted(); return run(job.value); })
        .catch(fail).finally(() => { active.delete(task); lanes.delete(job.lane); schedule(); });
      active.add(task);
    }
  };
  const schedule = () => { if (!scheduled) { scheduled = true; queueMicrotask(pump); } };
  return Object.freeze({
    enqueue(value, lane) {
      signal?.throwIfAborted();
      if (failed) throw failure;
      pending.push({ value, lane }); schedule();
    },
    async drain() {
      for (;;) {
        pump();
        if (!active.size) break;
        await Promise.all([...active]);
      }
      if (failed) throw failure;
      signal?.throwIfAborted();
    },
    get pending() { return pending.length; },
  });
}
