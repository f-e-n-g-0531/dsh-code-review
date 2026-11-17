// Only composition code supplies this resolver; never accept a cwd from tool arguments.
export async function reviewOwner(exec, resolveCwd) {
  const agent = exec?.agent;
  const session = agent?.session;
  const cwd = resolveCwd === undefined ? session?.header?.cwd : await resolveCwd(exec);
  if (exec?.agent !== agent || agent?.session !== session) throw new Error('Agent/session changed while resolving directory');
  if (!agent || typeof cwd !== 'string' || !cwd || !agent.options?.provider || !agent.options?.model) throw new Error('Active Agent with cwd and model is required');
  return { agent, session, sessionId: session?.header?.id ?? session?.id, cwd, route: { provider: agent.options.provider, model: agent.options.model, ...(agent.options.reasoningEffort ? { reasoningEffort: agent.options.reasoningEffort } : {}) } };
}

export function sameReviewOwner(a, b) {
  return a.agent === b.agent && a.session === b.session && a.sessionId === b.sessionId && a.cwd === b.cwd && JSON.stringify(a.route) === JSON.stringify(b.route);
}

export function ownerGuard(exec, resolveCwd, expected, message = 'Agent/session/directory/model changed during review; preview again') {
  return async () => {
    if (!sameReviewOwner(expected, await reviewOwner(exec, resolveCwd))) throw new Error(message);
  };
}

// Check every actual stream, including adapter JSON corrections, not just the first call.
export function guardReviewLlm(llm, check) {
  return { async *stream(...args) { await check(); yield* llm.stream(...args); } };
}
