import { requestModelApproval } from './src/model-approval.mjs';
import { createReviewService } from './src/service.mjs';
export const name = 'dsh-code-review';
export const inject = ['tools', 'llm', 'approval'];

export function apply(ctx, config = {}) {
  const service = createReviewService(ctx.llm, {
    allowModelSending: config.allowModelSending === true,
    authorize: async ({ snapshot, route, exec }) => requestModelApproval(ctx.approval, {
      agent: exec.agent, toolName: 'code_review_execute', signal: exec.signal,
      reason: '只读代码审查将发送代码给 ' + route.provider + '/' + route.model + '。仓库：' + snapshot.root + '；快照：' + snapshot.id + '；文件：' + JSON.stringify(snapshot.files.filter(f => f.eligibility === 'reviewable').map(f => f.path)) + '；上下文：' + JSON.stringify(snapshot.context.map(c => c.path)) + '；项目规则（全文将发送）：' + JSON.stringify((snapshot.rules ?? []).map(({ path, hash }) => ({ path, hash }))),
    }),
  });
  const output = {
    schema: { type: 'object', additionalProperties: false, properties: { json: { type: 'string' }, markdown: { type: 'string' } }, required: ['json', 'markdown'] },
    render: (_args, value) => [{ type: 'text', text: value.markdown || value.json }],
  };
  ctx.tools.register({
    name: 'code_review_preview', description: 'Preview Git/SVN working-copy review scope and model destination without sending source to a model. repositoryPath selects an explicit child repository relative to session workspace; file paths are repository-relative. Preview each repository separately. Show the preview before execution.',
    parameters: { type: 'object', additionalProperties: false, properties: { repositoryPath: { type: 'string', description: 'Workspace-relative explicit child Git/SVN repository root, forward slashes; omit for current repository.' }, selectedPaths: { type: 'array', items: { type: 'string' }, maxItems: 200 }, contextPaths: { type: 'array', items: { type: 'string' }, maxItems: 20 }, rulePaths: { type: 'array', items: { type: 'string' }, maxItems: 4 } } },
    output,
    async execute(args, exec) { const preview = await service.preview(args, exec); return { json: JSON.stringify(preview), markdown: '' }; },
  });
  ctx.tools.register({
    name: 'code_review_execute', description: 'Execute a previewed read-only code review using the current DSH model. Requires host user approval to send code. Never modifies the reviewed repository.',
    parameters: { type: 'object', additionalProperties: false, properties: { previewId: { type: 'string' }, confirmed: { type: 'boolean' } }, required: ['previewId', 'confirmed'] },
    output,
    async execute(args, exec) { const result = await service.execute(args, exec); return { json: JSON.stringify(result.report), markdown: result.markdown }; },
  });
  ctx.on('dispose', () => service.dispose());
}
