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
    parameters: { type: 'object', additionalProperties: false, properties: { reviewRounds: { type: 'integer', minimum: 1, maximum: 3, description: 'Explicit independent review passes, default 1. Preview discloses extra sends; later passes omit the first risk plan. Shares existing timeout, call and retrieval budgets, not provider reasoning effort. Bound to this preview; execute cannot override.' }, oldContextPaths: { type: 'array', maxItems: 20, items: { type: 'string' }, description: 'Explicit Git historical baseline-only blob context paths. Shares 20 context slots. No target text is inferred; selected old changes reuse their original identity, excluded changes cannot reenter. Unsupported on working reviews and SVN.' }, callerScopePaths: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string' }, description: 'Explicit non-root repository-relative directories for bounded tracked literal reverse import/include discovery. Git/SVN working review or Git fixed commit/range review. SVN uses offline normal nodes, rejects unsafe ancestor states and special/keyword properties. Historical sides share scan budgets and use object blobs only. Preview reads candidate bodies, including nonmatches; only captured matching context is sent. Navigation only, not complete caller coverage.' }, businessRequirement: { type: 'string', maxLength: 16384, description: 'Optional business constraint text up to 16KiB UTF8; untrusted data, not evidence or permission. Bound to preview and sent in review phases.' }, commit: { type: 'string', description: 'Git commit versus sole parent; root empty, merge requires range.' }, baseRevision: { type: 'string', description: 'Git old endpoint; requires targetRevision, mutually exclusive with commit.' }, targetRevision: { type: 'string', description: 'Git new endpoint, exact tree endpoints not merge-base. Explicit context uses target tree with available baseline provenance; oldContextPaths is baseline-only. Historical caller discovery scans fixed sides; explicit rules use target-tree blobs.' }, repositoryPath: { type: 'string', description: 'Workspace-relative explicit child Git/SVN repository root, forward slashes; omit for current repository.' }, selectedPaths: { type: 'array', items: { type: 'string' }, maxItems: 200 }, autoContext: { type: 'boolean', description: 'Opt in to tracked literal import/include context shown in preview. Working Git follows changed and explicitly selected context sources at most 3 dependency layers under shared 512 exact probes, 20 candidates/context slots, 1MiB source and 30s verification budget. Git history follows at most 3 baseline/target dependency layers with shared limits, object reads only; SVN follows at most 3 safe offline current-side layers with exact path probes and node/ancestor identity verification, sharing limits; no SVN historical review. Not semantic binding or complete definitions.' }, contextPaths: { type: 'array', items: { type: 'string' }, maxItems: 20 }, rulePaths: { type: 'array', items: { type: 'string' }, maxItems: 4 } } },
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
