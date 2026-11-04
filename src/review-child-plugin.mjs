import { assertReviewChildAgent, executeReviewChildRequests } from './review-child-broker.mjs';

export const name = 'dsh-code-review-restricted-child';
export const inject = ['tools'];

export function registerSnapshotTool(ctx) {
  // Presets are shared generations: never capture a particular child here.
  // Restrict inherited tools before resolution; host-owned structured_output remains.
  ctx.tools.register({
    name: 'review_snapshot',
    description: 'Internal tool for registered review children only; ordinary parent/other agents cannot call it. Read only the approved review snapshot using catalog retrieval requests. No filesystem, shell, network, or additional agents.',
    parameters: { type: 'object', additionalProperties: false, properties: { requests: { type: 'array', items: { type: 'object' } } }, required: ['requests'] },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { json: { type: 'string' } }, required: ['json'] },
      render: (_args, value) => [{ type: 'text', text: value.json }],
    },
    async execute(args, exec) {
      const result = await executeReviewChildRequests(args, exec);
      // Recheck after asynchronous business logic: revoked work cannot leak a result.
      assertReviewChildAgent(exec?.agent?.id, exec?.agent);
      return { json: JSON.stringify(result) };
    },
  });
}
export function apply(ctx) {
  ctx.tools.restrict({ allow: ['review_snapshot'] });
  // Identity only: installation above must precede the host's tool assembly.
  ctx.on('agent/pre-step', ({ agent }, next) => {
    assertReviewChildAgent(agent?.id, agent);
    return next();
  });
}
