/** Run a bounded set of workers, always joining admitted work before rejecting.
 * Cancellation rejects with signal.reason after the join; a worker failure takes
 * precedence, including when onFatal synchronously aborts the outer controller.
 */
export async function runWholeScopeWorkers(items, run, { concurrency = 2, signal, onFatal } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new RangeError('concurrency must be an integer from 1 to 4');
  }
  const results = new Array(items.length);
  let next = 0, failed = false, failure;
  async function worker() {
    while (!failed && !signal?.aborted && next < items.length) {
      const index = next++;
      try {
        results[index] = await run(items[index], index);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
          // Invoke before yielding so outer abort reaches other active work.
          // A throwing notification cannot replace the original worker failure.
          onFatal?.(error);
        }
      }
    }
  }
  await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  if (failed) throw failure;
  if (signal?.aborted) throw signal.reason;
  return results;
}

/** Serialize immutable checkpoint values. The first failure is permanent.
 * Internal rejection handlers prevent fire-and-forget enqueue calls from causing
 * unhandled rejections; callers still receive the original rejecting promise.
 */
export function createCheckpointQueue(save, onFatal) {
  let tail = Promise.resolve(), failed = false, failure;
  function rejectFirst(error) {
    if (!failed) {
      failed = true;
      failure = error;
      onFatal?.(error);
    }
    throw failure;
  }
  function observe(promise) {
    // Normalize notification exceptions back to the first persistence failure.
    tail = promise.catch(error => {
      if (failed) throw failure;
      return rejectFirst(error);
    });
    tail.catch(() => {});
    return tail;
  }
  return {
    enqueue(value) {
      if (save == null) return Promise.resolve();
      if (failed) return observe(Promise.reject(failure));
      let checkpoint;
      try {
        checkpoint = structuredClone(value);
      } catch (error) {
        // Retain FIFO even if cloning an enqueued value fails.
        return observe(tail.then(() => rejectFirst(error)));
      }
      return observe(tail.then(async () => {
        if (failed) throw failure;
        try {
          await save(checkpoint);
        } catch (error) {
          return rejectFirst(error);
        }
      }));
    },
    async drain() {
      // Also join values enqueued while a save is in progress.
      for (;;) {
        const pending = tail;
        await pending.catch(() => {});
        if (pending === tail) {
          if (failed) throw failure;
          return;
        }
      }
    },
  };
}
