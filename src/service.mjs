import { resolveWorkspaceRepository } from './workspace-repository.mjs';
import { randomUUID } from 'node:crypto';
import { buildCoveragePlan } from './coverage-plan.mjs';
import { createRetrievalScope } from './retrieval-scope.mjs';
import { buildReviewGroups } from './review-groups.mjs';
import { inferFileRelations } from './file-relations.mjs';
import { captureSnapshot } from './snapshot.mjs';
import { reviewSnapshot, markdownReport, REVIEW_INSTRUCTIONS } from './review.mjs';
import { createDshModel } from './dsh-model.mjs';

function owner(exec) {
  const agent = exec?.agent;
  const cwd = agent?.session?.header?.cwd;
  if (!agent || typeof cwd !== 'string' || !cwd || !agent.options?.provider || !agent.options?.model) throw new Error('Active Agent with cwd and model is required');
  return { agent, cwd, route: { provider: agent.options.provider, model: agent.options.model, ...(agent.options.reasoningEffort ? { reasoningEffort: agent.options.reasoningEffort } : {}) } };
}
export function createReviewService(llm, { capture = captureSnapshot, now = Date.now, ttlMs = 300000, maxPreviews = 8, allowModelSending = false, enableRiskPlanning = false, enableBusinessGrouping = false, enableAnchorCorrection = false, authorize = async () => false } = {}) {
  for (const value of [ttlMs, maxPreviews]) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid preview limit');
  const lifetime = new AbortController();
  const bind = exec => ({ ...exec, signal: exec.signal ? AbortSignal.any([exec.signal, lifetime.signal]) : lifetime.signal });
  const previews = new Map();
  let busy = false;
  function prune() { for (const [id, p] of previews) if (p.expires <= now()) previews.delete(id); }
  return {
    async preview(args, exec) {
      exec = bind(exec);
      exec.signal.throwIfAborted();
      if (busy) throw new Error('Review service busy');
      if (!args || Object.keys(args).some(k => !['repositoryPath', 'selectedPaths', 'contextPaths', 'rulePaths', 'autoContext'].includes(k))) throw new Error('Unknown preview argument');
      if (args.autoContext !== undefined && typeof args.autoContext !== 'boolean') throw new Error('Invalid autoContext option');
      for (const key of ['selectedPaths', 'contextPaths', 'rulePaths']) if (args[key] !== undefined && (!Array.isArray(args[key]) || args[key].length > (key === 'rulePaths' ? 4 : 200) || args[key].some(p => typeof p !== 'string'))) throw new Error('Invalid path list');
      const current = owner(exec);
      busy = true;
      try {
        const options = structuredClone(args);
        const target = await resolveWorkspaceRepository(current.cwd, options.repositoryPath);
        const snapshot = await capture(target, { ...options, signal: exec.signal });
        exec.signal?.throwIfAborted();
        if (owner(exec).cwd !== current.cwd) throw new Error('Agent directory changed; preview again');
        const plan = buildCoveragePlan(snapshot, { enableRiskPlanning, enableBusinessGrouping, instructions: REVIEW_INSTRUCTIONS, scope: createRetrievalScope(snapshot, { signal: exec.signal }), grouping: buildReviewGroups(snapshot.files, inferFileRelations(snapshot.files)), maxInputBytes: 96 * 1024, signal: exec.signal });
        prune();
        while (previews.size >= maxPreviews) previews.delete(previews.keys().next().value);
        const previewId = randomUUID();
        previews.set(previewId, { ...current, target, options, snapshotId: snapshot.id, expires: now() + ttlMs });
        return { previewId, plan, snapshotId: snapshot.id, repositoryRoot: snapshot.root, vcs: snapshot.vcs, model: current.route, modelSendingEnabled: allowModelSending, files: snapshot.files.map(f => ({ path: f.path, eligibility: f.eligibility, reason: f.reason })), contextPaths: snapshot.context.map(c => c.path), ...(snapshot.autoContext ? { autoContext: snapshot.autoContext } : {}), rules: (snapshot.rules ?? []).map(({ path, hash }) => ({ path, hash })), notice: (enableRiskPlanning ? '执行先制定风险假设计划，再审查并复核；计划不是证据，所有阶段共享原预算。' : '') + '执行会向上述模型提供方发送可审查文件两侧内容、预览列出的显式/自动上下文及所选项目规则全文。模型可在该快照范围内多轮只读检索，不读取范围外文件；候选生成后会进行证据与反证复核，两阶段各最多3轮检索，共享每文件120秒和总模型调用100次预算；复核不能证明缺陷成立。plan仅预检初始输入，ready不代表已审查；minimumCalls不含后续检索/复核/动态业务综合；多文件可先进行业务分组，分组失败保留原组并记录限制，动态综合数执行前未知，实际预算可能不足。请先向用户展示范围，获得确认后执行。' };
      } finally { busy = false; }
    },
    async execute(args, exec) {
      exec = bind(exec);
      exec.signal.throwIfAborted();
      if (busy) throw new Error('Review service busy');
      if (!allowModelSending) throw new Error('Model sending is disabled by plugin configuration');
      if (!args || Object.keys(args).some(k => !['previewId', 'confirmed'].includes(k)) || args.confirmed !== true || typeof args.previewId !== 'string') throw new Error('Confirmed preview is required');
      prune();
      const current = owner(exec), preview = previews.get(args.previewId);
      if (!preview || preview.agent !== current.agent || preview.cwd !== current.cwd || JSON.stringify(preview.route) !== JSON.stringify(current.route)) throw new Error('Preview missing, expired or owner/model/directory changed');
      busy = true;
      previews.delete(args.previewId);
      try {
        const target = await resolveWorkspaceRepository(current.cwd, preview.options.repositoryPath);
        if (target !== preview.target) throw new Error('Repository target changed; preview again');
        const snapshot = await capture(target, { ...preview.options, signal: exec.signal });
        exec.signal?.throwIfAborted();
        if (snapshot.id !== preview.snapshotId || owner(exec).cwd !== current.cwd) throw new Error('Files changed since preview; preview again');
        if (await authorize({ snapshot, route: preview.route, exec }) !== true) throw new Error('Model sending approval denied or unavailable');
        exec.signal?.throwIfAborted();
        if (owner(exec).cwd !== current.cwd || JSON.stringify(owner(exec).route) !== JSON.stringify(preview.route)) throw new Error('Agent changed during approval');
        const report = await reviewSnapshot(snapshot, createDshModel(llm, preview.route), { signal: exec.signal, enableRetrieval: true, enableGrouping: true, enableVerification: true, enableRiskPlanning, enableBusinessGrouping, enableAnchorCorrection });
        report.model = preview.route;
        const latest = await resolveWorkspaceRepository(current.cwd, preview.options.repositoryPath).then(target => target === preview.target ? capture(target, { ...preview.options, signal: exec.signal }) : null).catch(() => null);
        report.outdated = !latest || latest.id !== snapshot.id || owner(exec).cwd !== current.cwd;
        return { report, markdown: markdownReport(report) + (report.outdated ? '\n注意：代码已变化或无法重新验证，报告仅对应原快照。\n' : '') };
      } finally { busy = false; }
    },
    dispose() { lifetime.abort(new Error('Review service disposed')); previews.clear(); },
  };
}
