// Shared across cases/phases. This wrapper grants no authorization and makes no retries.
export function createEvaluationCallBudget(executor, limit) {
  if (typeof executor !== 'function' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid evaluation call budget');
  let used = 0;
  return Object.freeze({
    async execute(request) {
      request?.signal?.throwIfAborted();
      if (used >= limit) throw new Error('Evaluation call budget exhausted');
      // Reserve synchronously, before awaiting execution; failed sends consume a slot.
      used++;
      return await executor(request);
    },
    usage: () => ({ used, limit, remaining: limit - used })
  });
}
