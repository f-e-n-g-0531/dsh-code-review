import { validateCallerScopes } from './caller-index.mjs';
import { validateBusinessRequirement } from './business-requirement.mjs';
import { hash } from './content.mjs';
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
export function createReviewService(llm, { capture = captureSnapshot, now = Date.now, ttlMs = 300000, maxPreviews = 8, allowModelSending = false, enableRiskPlanning = false, skipSmallRiskPlans = true, reviewRounds = 1, enableBusinessGrouping = false, enableAnchorCorrection = false, authorize = async () => false } = {}) {
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
      if (!args || Object.keys(args).some(k => !['repositoryPath', 'selectedPaths', 'contextPaths', 'rulePaths', 'autoContext', 'commit', 'baseRevision', 'targetRevision','businessRequirement','callerScopePaths','oldContextPaths'].includes(k))) throw new Error('Unknown preview argument');
      if (args.autoContext !== undefined && typeof args.autoContext !== 'boolean') throw new Error('Invalid autoContext option');
      for (const key of ['selectedPaths', 'contextPaths', 'rulePaths', 'oldContextPaths']) if (args[key] !== undefined && (!Array.isArray(args[key]) || args[key].length > (key === 'rulePaths' ? 4 : key === 'oldContextPaths' ? 20 : 200) || args[key].some(p => typeof p !== 'string'))) throw new Error('Invalid path list');
      validateBusinessRequirement(args.businessRequirement);
      if (args.callerScopePaths !== undefined) validateCallerScopes(args.callerScopePaths);
      const current = owner(exec);
      busy = true;
      try {
        const options = structuredClone(args);
        const target = await resolveWorkspaceRepository(current.cwd, options.repositoryPath);
        const snapshot = await capture(target, { ...options, signal: exec.signal });
        exec.signal?.throwIfAborted();
        if (owner(exec).cwd !== current.cwd) throw new Error('Agent directory changed; preview again');
        const plan = buildCoveragePlan(snapshot, { enableRiskPlanning, skipSmallRiskPlans, reviewRounds, enableBusinessGrouping, instructions: REVIEW_INSTRUCTIONS, scope: createRetrievalScope(snapshot, { signal: exec.signal }), grouping: buildReviewGroups(snapshot.files, inferFileRelations(snapshot.files)), maxInputBytes: 96 * 1024, signal: exec.signal });
        prune();
        while (previews.size >= maxPreviews) previews.delete(previews.keys().next().value);
        const previewId = randomUUID();
        previews.set(previewId, { ...current, target, options, snapshotId: snapshot.id, expires: now() + ttlMs });
        return { ...(options.businessRequirement!==undefined?{businessRequirement:{text:options.businessRequirement,hash:hash(options.businessRequirement),bytes:Buffer.byteLength(options.businessRequirement)}}:{}), previewId, plan, snapshotId: snapshot.id, repositoryRoot: snapshot.root, vcs: snapshot.vcs, ...(snapshot.history ? { history: snapshot.history } : {}), model: current.route, modelSendingEnabled: allowModelSending, files: snapshot.files.map(f => ({ path: f.path, eligibility: f.eligibility, reason: f.reason })), contextPaths: snapshot.context.map(c => c.path), ...(options.oldContextPaths !== undefined ? {oldContextPaths:options.oldContextPaths,oldContextSources:snapshot.context.filter(c=>c.oldOnly).map(c=>({path:c.path,side:'context-old',revision:c.oldRevision,blobOid:c.oldBlobOid,hash:c.oldHash}))} : {}), ...(snapshot.callerDiscovery ? {callerDiscovery:snapshot.callerDiscovery} : {}), ...(snapshot.autoContext ? { autoContext: snapshot.autoContext } : {}), rules: (snapshot.rules ?? []).map(({ path, hash }) => ({ path, hash })), notice: (options.oldContextPaths !== undefined ? 'oldContextPaths仅为baseline旧侧正文，无目标侧替代；选中变更复用原old身份，旧侧不能证明新侧行为。' : '') + (snapshot.callerDiscovery ? 'callerScopePaths已授权预览读取限定目录内tracked候选正文，包括不匹配文件；非匹配正文不发送模型，匹配捕获上下文会发送。仅字面引用导航，不是函数调用或完整调用覆盖。' : '') + (enableRiskPlanning ? '执行按plan阈值决定风险假设规划，小变更可跳过独立规划但仍主审并复核；计划不是证据，所有阶段共享原预算。' : '') + '执行会向上述模型提供方发送可审查文件两侧内容、预览列出的显式/自动上下文、所选项目规则全文及预览业务需求文本。模型可在该快照范围内多轮只读检索，不读取范围外文件；候选生成后会进行证据与反证复核，两阶段各最多3轮检索，共享每文件120秒和总模型调用100次预算；复核不能证明缺陷成立。plan.reviewRounds为独立审查工作量，非模型reasoning effort；后续轮不带首轮风险计划，所有轮共享原超时与预算。plan仅预检初始输入，ready不代表已审查；minimumCalls不含后续检索/复核/动态业务综合；多文件可先进行业务分组，分组失败保留原组并记录限制，动态综合数执行前未知，实际预算可能不足。请先向用户展示范围，获得确认后执行。' };
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
        const report = await reviewSnapshot(snapshot, createDshModel(llm, preview.route), { signal: exec.signal, enableRetrieval: true, enableGrouping: true, enableVerification: true, enableRiskPlanning, skipSmallRiskPlans, reviewRounds, enableBusinessGrouping, enableAnchorCorrection });
        report.model = preview.route;
        const latest = await resolveWorkspaceRepository(current.cwd, preview.options.repositoryPath).then(target => target === preview.target ? capture(target, { ...preview.options, signal: exec.signal }) : null).catch(() => null);
        report.outdated = !latest || latest.id !== snapshot.id || owner(exec).cwd !== current.cwd;
        return { report, markdown: markdownReport(report) + (report.outdated ? '\n注意：代码已变化或无法重新验证，报告仅对应原快照。\n' : '') };
      } finally { busy = false; }
    },
    dispose() { lifetime.abort(new Error('Review service disposed')); previews.clear(); },
  };
}
