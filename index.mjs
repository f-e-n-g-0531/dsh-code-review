import { createReviewService } from './src/service.mjs';
export const name = 'dsh-code-review';
export const inject = ['tools', 'llm'];

export function apply(ctx, config = {}) {
  // This entry runs only when the host invokes the registered tool.
  // Host tool policy owns permission; do not request a second approval here.
  const service = createReviewService(ctx.llm, { allowModelSending: true, enableRiskPlanning: true, enableBusinessGrouping: true, enableAnchorCorrection: true, authorize: async () => true });
  const output = {
    schema: { type: 'object', additionalProperties: false, properties: { json: { type: 'string' }, markdown: { type: 'string' } }, required: ['json', 'markdown'] },
    render: (_args, value) => [{ type: 'text', text: value.markdown || value.json }],
  };
  ctx.tools.register({
    name: 'code_review_preview', description: 'Preview Git/SVN working-copy or Git commit/range review scope and model destination without sending source to a model. repositoryPath selects an explicit child repository relative to session workspace; file paths are repository-relative. Preview each repository separately. Show the preview before execution.',
    parameters: { type: 'object', additionalProperties: false, properties: { commit: { type: 'string', description: 'Git commit versus sole parent; root empty, merge requires range.' }, baseRevision: { type: 'string', description: 'Git old endpoint; requires targetRevision, mutually exclusive with commit.' }, targetRevision: { type: 'string', description: 'Git new endpoint, exact tree endpoints not merge-base. Context is captured from target tree only; historical rules rejected.' }, repositoryPath: { type: 'string', description: 'Workspace-relative explicit child Git/SVN repository root, forward slashes; omit for current repository.' }, selectedPaths: { type: 'array', items: { type: 'string' }, maxItems: 200 }, autoContext: { type: 'boolean', description: 'Opt in to bounded direct tracked Git/SVN import/include context captured and shown in preview.' }, contextPaths: { type: 'array', items: { type: 'string' }, maxItems: 20 }, rulePaths: { type: 'array', items: { type: 'string' }, maxItems: 4 } } },
    output,
    async execute(args, exec) { const preview = await service.preview(args, exec); return { json: JSON.stringify(preview), markdown: '' }; },
  });
  ctx.tools.register({
    name: 'code_review_execute', description: 'Execute a previewed read-only code review using the current DSH model. Sends the approved snapshot to the current Agent model under DSH tool execution policy; no separate plugin approval prompt. Never modifies the reviewed repository.',
    parameters: { type: 'object', additionalProperties: false, properties: { previewId: { type: 'string' }, confirmed: { type: 'boolean' } }, required: ['previewId', 'confirmed'] },
    output,
    async execute(args, exec) { const result = await service.execute(args, exec); return { json: JSON.stringify(result.report), markdown: result.markdown }; },
  });
  ctx.on('dispose', () => service.dispose());
}
