import { configureWireBudget } from './model-wire-budget.mjs';
import {REVIEW_RUNTIME} from './runtime-identity.mjs';
import { buildResumeState, validateResumeState, resumePreview } from './review-resume.mjs';
import { reviewDiagnostics } from './review-diagnostics.mjs';
import {createProjectReviewService} from './project-review-service.mjs';
import {svnDiagnostic} from './svn-diagnostics.mjs';
import { reviewRounds as validateReviewRounds } from './review-rounds.mjs';
import { changesConcurrency as reviewConcurrency, retrievalRounds as reviewRetrievalRounds } from './review-execution-policy.mjs';
import { validateCallerScopes } from './caller-index.mjs';
import { validateBusinessRequirement } from './business-requirement.mjs';
import { hash } from './content.mjs';
import { changeScopePreviewNotice } from './git-change-scope.mjs';
import { resolveWorkspaceRepository } from './workspace-repository.mjs';
import { randomUUID } from 'node:crypto';
import { buildCoveragePlan } from './coverage-plan.mjs';
import { createRetrievalScope } from './retrieval-scope.mjs';
import { buildReviewGroups } from './review-groups.mjs';
import { inferFileRelations } from './file-relations.mjs';
import { captureSnapshot } from './snapshot.mjs';
import { reviewSnapshot, markdownReport, REVIEW_INSTRUCTIONS } from './review.mjs';
import { createDshModel } from './dsh-model.mjs';
import { reviewReaderBudget } from './review-reader-policy.mjs';
import { riskPlanningMode as validateRiskPlanningMode } from './risk-strategy.mjs';

function owner(exec) {
  const agent = exec?.agent;
  const cwd = agent?.session?.header?.cwd;
  if (!agent || typeof cwd !== 'string' || !cwd || !agent.options?.provider || !agent.options?.model) throw new Error('Active Agent with cwd and model is required');
  return { agent, cwd, route: { provider: agent.options.provider, model: agent.options.model, ...(agent.options.reasoningEffort ? { reasoningEffort: agent.options.reasoningEffort } : {}) } };
}
/** Project one snapshot file into its preview shape; keeps the dense conditionals in one place. */
function describeFile(file, snapshot) {
  return {
    path: file.path,
    ...(file.workingSource ? { workingSource: file.workingSource } : {}),
    ...(file.replacementSource ? { replacementSource: file.replacementSource, contentNotice: file.contentNotice } : {}),
    eligibility: file.eligibility,
    reason: file.reason,
    ...(file.specialData ? { specialData: file.specialData, contentNotice: file.contentNotice } : {}),
    ...(file.eolMapping ? { eolMapping: file.eolMapping, textNotice: file.textNotice } : {}),
    ...(file.keywordMapping ? { keywordMapping: file.keywordMapping, textNotice: file.textNotice } : {}),
    ...(file.rawStatus === 'replaced' && (snapshot.history?.vcs === 'svn' || file.replacementSource)
      ? { oldKind: file.oldKind, newKind: file.newKind, nodeNotice: file.nodeNotice }
      : {}),
    ...(file.blockCode
      ? { blockCode: file.blockCode, ...(svnDiagnostic(file.blockCode) ? { diagnostic: svnDiagnostic(file.blockCode) } : {}) }
      : {}),
    ...(file.copySource ? { copySource: file.copySource, copyNotice: file.copyNotice } : {}),
  };
}

/** Compose the user-facing preview notice; text is verbatim from the original rules. */
function buildPreviewNotice(snapshot, options, enableRiskPlanning, changesConcurrency, maxRetrievalRounds) {
  const scopeNotice = options.changeScope !== undefined && options.changeScope !== 'worktree' ? changeScopePreviewNotice(options.changeScope) : '';
  return scopeNotice + (snapshot.history?.vcs==='svn'&&options.autoContext===true?'SVN历史autoContext为精确依赖定位读取固定版本父目录有界清单，包含同目录非匹配名字元数据；仅匹配捕获正文发送模型，不扫描全仓，不用工作树替代历史版本。':'') + (options.oldContextPaths !== undefined ? 'oldContextPaths仅为baseline旧侧正文，无目标侧替代；选中变更复用原old身份，旧侧不能证明新侧行为。' : '') + (snapshot.callerDiscovery ? 'callerScopePaths已授权预览读取限定目录内tracked候选正文，包括不匹配文件；非匹配正文不发送模型，匹配捕获上下文会发送。仅字面引用导航，不是函数调用或完整调用覆盖。' : '') + (enableRiskPlanning ? '执行按plan阈值决定风险假设规划，小变更可跳过独立规划但仍主审并复核；计划不是证据，所有阶段共享原预算。' : '') + `执行会向上述模型提供方发送可审查文件两侧内容、预览列出的显式/自动上下文、所选项目规则全文及预览业务需求文本。模型可在该快照范围内多轮只读检索，不读取范围外文件；候选生成后会进行证据与反证复核，两阶段各最多${maxRetrievalRounds}轮检索；独立文件审查链最多${changesConcurrency}条并发，不设插件内部默认时间或总模型调用次数截止，遵循宿主/用户取消；输入字节和检索轮次保护仍保留；复核不能证明缺陷成立。plan.reviewRounds为独立审查工作量，非模型reasoning effort；后续轮不带首轮风险计划，所有轮共享原超时与预算。plan仅预检初始输入，ready不代表已审查；minimumCalls不含后续检索/复核/动态业务综合；多文件可先进行业务分组，分组失败保留原组并记录限制，动态综合数执行前未知，实际预算可能不足。请先向用户展示范围，获得确认后执行。`;
}

function createSessionReviewService(llm, { capture = captureSnapshot, now = Date.now, ttlMs = 300000, maxPreviews = 8, allowModelSending = false, enableRiskPlanning = false, skipSmallRiskPlans = true, reviewRounds = 1, enableBusinessGrouping = false, enableAnchorCorrection = false, changesConcurrency = 2, maxRetrievalRounds = 3, riskPlanningMode = 'separate', readerBudgetPolicy = 'fixed', optimizeReviewCalls = false, enablePrimarySeeds = false, focusPrimaryContext = false, enableSearchSeeds = false, nativeOutputTools = false, enableGroupPrimary = false, authorize = async () => false } = {}) {
  for (const value of [ttlMs, maxPreviews]) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid preview limit');
  changesConcurrency = reviewConcurrency(changesConcurrency);
  maxRetrievalRounds = reviewRetrievalRounds(maxRetrievalRounds);
  riskPlanningMode = validateRiskPlanningMode(riskPlanningMode);
  reviewReaderBudget({ files: [] }, readerBudgetPolicy);
  for (const value of [optimizeReviewCalls, enablePrimarySeeds, focusPrimaryContext, enableSearchSeeds, nativeOutputTools, enableGroupPrimary]) if (typeof value !== 'boolean') throw new Error('Invalid review optimization option');
  const lifetime = new AbortController();
  const bind = exec => ({ ...exec, signal: exec.signal ? AbortSignal.any([exec.signal, lifetime.signal]) : lifetime.signal });
  const resumeOptions = (options, route, rounds) => ({ captureOptions: options, route, runtime: REVIEW_RUNTIME, instructionsHash: hash(REVIEW_INSTRUCTIONS), execution: { rounds, enableRiskPlanning, skipSmallRiskPlans, enableBusinessGrouping, enableAnchorCorrection, changesConcurrency, maxRetrievalRounds, riskPlanningMode, readerBudgetPolicy, optimizeReviewCalls, enablePrimarySeeds, focusPrimaryContext, enableSearchSeeds, nativeOutputTools, enableGroupPrimary } });
  const previews = new Map();
  let busy = false;
  function prune() { for (const [id, p] of previews) if (p.expires <= now()) previews.delete(id); }
  return {
    async preview(args, exec) {
      exec = bind(exec);
      exec.signal.throwIfAborted();
      if (busy) throw new Error('Review service busy');
      if (!args || Object.keys(args).some(k => !['repositoryPath', 'selectedPaths', 'contextPaths', 'rulePaths', 'autoContext', 'commit', 'baseRevision', 'targetRevision','businessRequirement','callerScopePaths','oldContextPaths','reviewRounds','svnRevision','svnBaseRevision','svnTargetRevision','svnAllowNetwork','svnEffectiveMergeinfo','svnBasePath','svnTargetPath','svnReplacementBaseRevision','svnReplacementAllowNetwork','changeScope','resumeFromJobId'].includes(k))) throw new Error('Unknown preview argument');
      if (args.resumeFromJobId !== undefined && (typeof args.resumeFromJobId !== 'string' || !/^[a-f0-9-]{36}$/.test(args.resumeFromJobId))) throw new Error('Invalid resume job id');
      if (args.autoContext !== undefined && typeof args.autoContext !== 'boolean') throw new Error('Invalid autoContext option');
      for (const key of ['selectedPaths', 'contextPaths', 'rulePaths', 'oldContextPaths']) if (args[key] !== undefined && (!Array.isArray(args[key]) || args[key].length > (key === 'rulePaths' ? 4 : key === 'oldContextPaths' ? 20 : 200) || args[key].some(p => typeof p !== 'string'))) throw new Error('Invalid path list');
      const rounds=validateReviewRounds(args.reviewRounds === undefined ? reviewRounds : args.reviewRounds);
      validateBusinessRequirement(args.businessRequirement);
      if (args.callerScopePaths !== undefined) validateCallerScopes(args.callerScopePaths);
      const current = owner(exec);
      busy = true;
      try {
        const options = structuredClone(args);
        const sourceJobId = options.resumeFromJobId;
        delete options.resumeFromJobId;
        let savedResume;
        if (sourceJobId !== undefined) {
          if (typeof exec.resolveReviewResume !== 'function') throw new Error('Durable job resume is unavailable; use a new background preview');
          savedResume = await exec.resolveReviewResume(sourceJobId);
        }
        const target = await resolveWorkspaceRepository(current.cwd, options.repositoryPath);
        const snapshot = await capture(target, { ...options, signal: exec.signal });
        exec.signal?.throwIfAborted();
        if (owner(exec).cwd !== current.cwd) throw new Error('Agent directory changed; preview again');
        const resumeState = savedResume === undefined ? undefined : validateResumeState(savedResume, snapshot, resumeOptions(options, current.route, rounds));
        const readerBudget = reviewReaderBudget(snapshot, readerBudgetPolicy);
        const plan = buildCoveragePlan(snapshot, { enableGroupPrimary, resumeState, focusPrimaryContext, riskPlanningMode, enableRiskPlanning, skipSmallRiskPlans, reviewRounds:rounds, enableBusinessGrouping, instructions: REVIEW_INSTRUCTIONS, scope: configureWireBudget(createRetrievalScope(snapshot, { ...readerBudget, signal: exec.signal }), { nativeOutputTools }), grouping: buildReviewGroups(snapshot.files, inferFileRelations(snapshot.files)), maxInputBytes: 96 * 1024, signal: exec.signal });
        prune();
        while (previews.size >= maxPreviews) previews.delete(previews.keys().next().value);
        const previewId = randomUUID();
        previews.set(previewId, { ...current, target, options, rounds, snapshotId: snapshot.id, resumeState, sourceJobId, expires: now() + ttlMs });
        return {
  ...(options.businessRequirement !== undefined
    ? { businessRequirement: { text: options.businessRequirement, hash: hash(options.businessRequirement), bytes: Buffer.byteLength(options.businessRequirement) } }
    : {}),
  previewId,
  ...(resumeState ? { resume: resumePreview(resumeState, sourceJobId) } : {}),
  plan,
  snapshotId: snapshot.id,
  privateArtifacts: { enabled: typeof exec.onModelArtifact === 'function', sourceBearing: true, maxArtifactBytes: 1048576, maxJobBytes: 8388608, maxArtifacts: 64, notice: 'Background jobs retain bounded untrusted model output outside the reviewed workspace; omissions/truncation explicit. Never included in ordinary status or reused as evidence; explicit consent required to read.' },
  execution: { nativeOutputTools, enableGroupPrimary, fileConcurrency: changesConcurrency, maxRetrievalRounds, ...(optimizeReviewCalls ? { riskPlanningMode, readerBudget: { policy: readerBudgetPolicy, ...readerBudget }, missingContextSeeds: enablePrimarySeeds, focusPrimaryContext, searchContextSeeds: enableSearchSeeds } : {}) },
  repositoryRoot: snapshot.root,
  vcs: snapshot.vcs,
  ...(snapshot.changeScope ? { changeScope: snapshot.changeScope } : options.changeScope !== undefined ? { changeScope: options.changeScope } : {}),
  ...(snapshot.workingScope ? { workingScope: snapshot.workingScope } : {}),
  ...(snapshot.history ? { history: snapshot.history } : {}),
  ...(snapshot.mergeSources ? { mergeSources: snapshot.mergeSources } : {}),
  ...(snapshot.effectiveMergeSources ? { effectiveMergeSources: snapshot.effectiveMergeSources } : {}),
  model: current.route,
  modelSendingEnabled: allowModelSending,
  files: snapshot.files.map(f => describeFile(f, snapshot)),
  contextPaths: snapshot.context.map(c => c.path),
  ...(snapshot.context.some(c => c.keywordMapping)
    ? { contextKeywordMappings: snapshot.context.filter(c => c.keywordMapping).map(c => ({ path: c.path, keywordMapping: c.keywordMapping })) }
    : {}),
  ...(snapshot.context.some(c => c.eolMapping)
    ? { contextEolMappings: snapshot.context.filter(c => c.eolMapping).map(c => ({ path: c.path, eolMapping: c.eolMapping })) }
    : {}),
  ...(snapshot.history?.vcs === 'svn'
    ? { contextSources: snapshot.context.map(c => ({ path: c.path, ...(c.svnSource ? { new: c.svnSource } : {}), ...(c.oldSvnSource ? { old: c.oldSvnSource } : {}) })) }
    : {}),
  ...(options.oldContextPaths !== undefined
    ? {
        oldContextPaths: options.oldContextPaths,
        oldContextSources: snapshot.context.filter(c => c.oldOnly).map(c => ({ path: c.path, side: 'context-old', revision: c.oldRevision, ...(c.oldSvnSource ? { svnSource: c.oldSvnSource } : { blobOid: c.oldBlobOid }), hash: c.oldHash })),
      }
    : {}),
  ...(snapshot.callerDiscovery ? { callerDiscovery: snapshot.callerDiscovery } : {}),
  ...(snapshot.autoContext ? { autoContext: snapshot.autoContext } : {}),
  rules: (snapshot.rules ?? []).map(({ path, hash }) => ({ path, hash })),
  notice: buildPreviewNotice(snapshot, options, enableRiskPlanning, changesConcurrency, maxRetrievalRounds) + (optimizeReviewCalls ? ` 完整正文或覆盖全部精确编辑的单批窗口可将风险问题合并入主审（非独立规划）；仅对批准上下文的确定坐标预取小片段，不代表完整核查。${focusPrimaryContext ? " 主审优先保留主文件全文，仅附带有关联的有界完整上下文；其余批准来源保留目录按需读，不表示不存在或已核查。" : ""}${enableSearchSeeds ? " 可将模型搜索命中的批准原行小片段与搜索结果同轮提供，每阶段最多2次额外读取，共用原预算；不猜测另侧坐标，不增加检索轮次。" : ""}共享检索上限按本次范围计算：${readerBudget.maxCalls}次操作／${readerBudget.maxOutputBytes}字节，所有阶段共用、不逐文件重置；无法取得必要证据的阶段不再无效启动。` : ''),
};
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
        const resumeIdentity = resumeOptions(preview.options, preview.route, preview.rounds);
        const resumeState = preview.resumeState ? validateResumeState(preview.resumeState, snapshot, resumeIdentity) : undefined;
        if (await authorize({ snapshot, route: preview.route, exec }) !== true) throw new Error('Model sending approval denied or unavailable');
        exec.signal?.throwIfAborted();
        if (owner(exec).cwd !== current.cwd || JSON.stringify(owner(exec).route) !== JSON.stringify(preview.route)) throw new Error('Agent changed during approval');
        await exec.reviewCheckpoint?.({stage:'approved-manifest',snapshotId:snapshot.id,files:snapshot.files.map(f=>({fileId:f.id,path:f.path,status:f.eligibility==='reviewable'?'pending':f.eligibility}))});
        const report = await reviewSnapshot(snapshot, createDshModel(llm, preview.route,{correctJson:true,useNativeTools:nativeOutputTools}), { signal: exec.signal, enableRetrieval: true, enableGrouping: true, enableGroupPrimary, nativeOutputTools, enableVerification: true, riskPlanningMode, readerBudgetPolicy, optimizeReviewCalls, enablePrimarySeeds, focusPrimaryContext, enableSearchSeeds, enableRiskPlanning, skipSmallRiskPlans, reviewRounds:preview.rounds, enableBusinessGrouping, enableAnchorCorrection,changesConcurrency,maxRetrievalRounds,correctProtocol:true, onProgress:exec.reviewCheckpoint, resumeState, onModelArtifact: exec.onModelArtifact, onResumeCheckpoint: exec.reviewResumeCheckpoint ? async checkpoint => { await exec.reviewResumeCheckpoint(buildResumeState(snapshot, resumeIdentity, checkpoint)); } : undefined });
        report.model = preview.route;
        if (exec.reviewResumeCheckpoint) await exec.reviewResumeCheckpoint(buildResumeState(snapshot, resumeIdentity, report));
        // reviewSnapshot preserves cancelled coverage; do not replace it with a freshness error.
        if (report.status === 'cancelled') {
          report.outdated = true;
        } else {
          await exec.reviewCheckpoint?.({ stage: 'source-freshness', snapshotId: snapshot.id });
          exec.signal.throwIfAborted();
          const latest = await resolveWorkspaceRepository(current.cwd, preview.options.repositoryPath).then(target => target === preview.target ? capture(target, { ...preview.options, signal: exec.signal }) : null).catch(() => { exec.signal.throwIfAborted(); return null; });
          exec.signal.throwIfAborted();
          report.outdated = !latest || latest.id !== snapshot.id || owner(exec).cwd !== current.cwd;
        }
        return { report, markdown: markdownReport(report) + (report.outdated ? '\n注意：代码已变化或无法重新验证，报告仅对应原快照。\n' : '') };
      } finally { busy = false; }
    },
    dispose() { lifetime.abort(new Error('Review service disposed')); previews.clear(); },
  };
}

/** Strip reviewMode from change-mode preview args before routing to the changes service. */
function normalizeChangesArgs(args) {
  return args?.reviewMode === 'changes'
    ? Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'reviewMode'))
    : args;
}

/** Route one preview/execute call to the matching per-mode service. */
function routeCall(kind, args, exec, { changes, project }) {
  if (kind === 'preview') {
    return args?.reviewMode === 'project'
      ? project.preview(args, exec)
      : changes.preview(normalizeChangesArgs(args), exec);
  }
  return project.owns(args?.previewId)
    ? project.execute(args, exec)
    : changes.execute(args, exec);
}

export function createReviewService(llm, options = {}) {
  const sessions = new Map();
  let disposed = false;

  function createSessionEntry() {
    const changes = createSessionReviewService(llm, options);
    const project = createProjectReviewService(llm, options);
    let locked = false;

    const call = async (kind, args, exec) => {
      if (locked) throw new Error('Review service busy');
      locked = true;
      try {
        return await routeCall(kind, args, exec, { changes, project });
      } finally {
        locked = false;
      }
    };

    return {
      preview: (args, exec) => call('preview', args, exec),
      execute: (args, exec) => call('execute', args, exec),
      dispose() {
        changes.dispose();
        project.dispose();
      },
    };
  }

  function get(exec) {
    if (disposed) throw new Error('Review service disposed');
    const agent = exec?.agent;
    const key = agent?.session ?? agent;
    if (!key || typeof key !== 'object') throw new Error('Active Agent required');
    if (!sessions.has(key)) sessions.set(key, createSessionEntry());
    return sessions.get(key);
  }

  return {
    async preview(args, exec) {
      const started = Date.now();
      await exec?.reviewCheckpoint?.({ stage: 'preview-started', runtime: REVIEW_RUNTIME });
      const result = await get(exec).preview(args, exec);
      return { ...result, runtime: REVIEW_RUNTIME, elapsedMs: Date.now() - started };
    },
    async execute(args, exec) {
      const started = performance.now();
      const result = await get(exec).execute(args, exec);
      result.report.diagnostics ??= reviewDiagnostics(result.report);
      result.report.diagnostics.executionWallMs = Math.round(performance.now() - started);
      return { ...result, markdown: result.markdown + '\n执行工具墙钟（含批准快照复核、审查和末尾来源复核，不含预览／用户确认等待）：' + (result.report.diagnostics.executionWallMs / 1000).toFixed(1) + ' 秒。\n' };
    },
    dispose() {
      disposed = true;
      for (const service of sessions.values()) service.dispose();
      sessions.clear();
    },
  };
}
