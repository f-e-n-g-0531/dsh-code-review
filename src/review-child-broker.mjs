// Process-local ownership broker. Fixtures exercise this contract, not host integration.
const bindings = new Map();
const revoked = new Set();
const attachments = new WeakMap();
const allowedTools = new Set(['review_snapshot', 'structured_output']);
const failure = (message) => Object.assign(new Error(message), { code: 'REVIEW_CHILD_IDENTITY' });

export function registerReviewChild(childId, binding) {
  if (typeof childId !== 'string' || !childId || bindings.has(childId) || revoked.has(childId)) throw failure('Child id is invalid, already reserved, or revoked');
  if (!binding || typeof binding.parentId !== 'string' || !binding.parentId || typeof binding.presetId !== 'string' || !binding.presetId || typeof binding.assertAgent !== 'function' || typeof binding.executeRequests !== 'function' || typeof binding.beforeModelCall !== 'function') throw failure('Incomplete restricted child binding');
  const entry = { binding };
  bindings.set(childId, entry);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    bindings.delete(childId);
    // Do not allow a late stream event to become an unrelated, unguarded call.
    revoked.add(childId);
  };
}

export function getReviewChildBinding(childId) {
  if (revoked.has(childId)) throw failure('Review child binding was revoked');
  return bindings.get(childId)?.binding;
}
export const getBinding = getReviewChildBinding;

export function assertReviewChildAgent(childId, agent) {
  const binding = getReviewChildBinding(childId);
  const header = agent?.session?.header;
  if (!binding || agent?.id !== childId || header?.id !== childId || header.parentSession !== binding.parentId || header.agentPreset !== binding.presetId) throw failure('Review child session, parent, or preset does not match its reservation');
  binding.assertAgent(agent);
  return binding;
}

export function executeReviewChildRequests(args, exec) {
  const childId = exec?.agent?.id;
  const binding = assertReviewChildAgent(childId, exec?.agent);
  return binding.executeRequests(args, exec);
}

export function attachReviewChildMiddleware(ctx) {
  if (attachments.has(ctx)) return attachments.get(ctx);
  const dispose = ctx.on('llm/stream', function (options, next) {
    const childId = options?.sessionId;
    const binding = getReviewChildBinding(childId);
    if (!binding) return next();
    try {
      const agent = ctx.get?.('agents')?.get?.(childId);
      assertReviewChildAgent(childId, agent);
      if (!Array.isArray(options.tools) || !options.tools.some(tool => tool?.name === 'structured_output') || options.tools.some(tool => !allowedTools.has(tool?.name)) || new Set(options.tools.map(tool => tool.name)).size !== options.tools.length) throw failure('Restricted child model tools changed');
      // Reservation/route/budget guard executes synchronously, before next dispatch.
      const result = binding.beforeModelCall(options);
      if (result && typeof result.then === 'function') throw failure('Child model-call guard must be synchronous');
    } catch (error) {
      // Poison the owner's activation even when failure precedes its budget guard.
      binding.onFatal?.(error);
      throw error;
    }
    return next();
  });
  attachments.set(ctx, dispose);
  return dispose;
}
