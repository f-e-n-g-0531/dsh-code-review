import { previewValidity } from './preview-validity.mjs';
import { renderUserReport } from './user-report.mjs';
import { prepareWholeScope } from './whole-scope-plan.mjs';
import { resolveReviewDispatch } from './review-dispatch.mjs';
import { reviewEffortPolicy } from './review-effort.mjs';
import { prepareReviewHistory, finishReviewHistory } from './review-history.mjs';
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
  return scopeNotice + (snapshot.history?.vcs==='svn'&&options.autoContext===true?'SVN历史autoContext为精确依赖定位读取固定版本父目录有界清单，包含同目录非匹配名字元数据；仅匹配捕获正文发送模型，不扫描全仓，不用工作树替代历史版本。':'') + (options.oldContextPaths !== undefined ? 'oldContextPaths仅为baseline旧侧正文，无目标侧替代；选中变更复用原old身份，旧侧不能证明新侧行为。' : '') + (snapshot.callerDiscovery ? 'callerScopePaths已授权预览读取限定目录内tracked候选正文，包括不匹配文件；非匹配正文不发送模型，匹配捕获上下文会发送。仅字面引用导航，不是函数调用或完整调用覆盖。' : '') + (enableRiskPlanning ? '执行按plan阈值决定风险假设规划，小变更可跳过独立规划但仍主审并复核；计划不是证据，所有阶段共享原预算。' : '') + `执行会向上述模型提供方发送可审查文件两侧内容、预览列出的显式/自动上下文、所选项目规则全文及预览业务需求文本。模型可在该快照范围内多轮只读检索，不读取范围外文件；候选生成后会进行证据与反证复核，两阶段各最多${maxRetrievalRounds}轮检索；独立文件审查链最多${changesConcurrency}条并发，不设插件内部默认时间或总模型调用次数截止，遵循宿主/用户取消；输入字节和检索轮次保护仍保留；复核不能证明缺陷成立。plan.reviewRounds为独立审查工作量，非模型reasoning effort；后续轮不带首轮风险计划，所有轮共享原超时与预算。plan仅预检初始输入，ready不代表已审查；minimumCalls不含后续检索/复核/动态业务综合；多文件可先进行业务分组，分组失败保留原组并记录限制，动态综合数执行前未知，实际预算可能不足。请先内部核对预览与当前人类授权。用户已明确要求审核且范围、模型和发送目的地一致时直接执行，不重复询问确认；只要求预览或明确要求等待确认时不得执行，超出授权或边界不明确时才询问。宿主权限和快照／身份校验仍须通过。`;
}

function createSessionReviewService(llm, { capture = captureSnapshot, reviewEffort = 'auto', enableCounterVerification = false, hostChildren, wholeScopeConcurrency = 2, executionStrategy = 'staged', maxInputBytes = 96 * 1024, now = Date.now, ttlMs = 300000, maxPreviews = 8, allowModelSending = false, enableRiskPlanning = false, skipSmallRiskPlans = true, reviewRounds = 1, enableBusinessGrouping = false, enableAnchorCorrection = false, changesConcurrency = 2, maxRetrievalRounds = 3, riskPlanningMode = 'separate', readerBudgetPolicy = 'fixed', optimizeReviewCalls = false, enablePrimarySeeds = false, focusPrimaryContext = false, enableSearchSeeds = false, nativeOutputTools = false, enableGroupPrimary = false, enableEvidenceContext = false, inlineInteractionRisks = false, enableMigrationContracts = false, enableMigrationRegression = false, enableGroupInteractions = false, enableStageContinuation = false, authorize = async () => false } = {}) {
  for (const value of [ttlMs, maxPreviews]) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid preview limit');
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1 || maxInputBytes > 4 * 1024 * 1024) throw new Error('Invalid configured input capacity');
  if (!['auto','staged', 'whole-scope'].includes(executionStrategy)) throw new Error('Invalid review execution strategy');
  if (!['auto','quick','standard','deep'].includes(reviewEffort) || typeof enableCounterVerification !== 'boolean') throw new Error('Invalid review effort policy');
  wholeScopeConcurrency = reviewConcurrency(wholeScopeConcurrency);
  changesConcurrency = reviewConcurrency(changesConcurrency);
  maxRetrievalRounds = reviewRetrievalRounds(maxRetrievalRounds);
  riskPlanningMode = validateRiskPlanningMode(riskPlanningMode);
  reviewReaderBudget({ files: [] }, readerBudgetPolicy);
  for (const value of [optimizeReviewCalls, enablePrimarySeeds, focusPrimaryContext, enableSearchSeeds, nativeOutputTools, enableGroupPrimary, enableEvidenceContext, inlineInteractionRisks, enableMigrationContracts, enableMigrationRegression, enableGroupInteractions, enableStageContinuation]) if (typeof value !== 'boolean') throw new Error('Invalid review optimization option');
  const lifetime = new AbortController();
  const bind = exec => ({ ...exec, signal: exec.signal ? AbortSignal.any([exec.signal, lifetime.signal]) : lifetime.signal });
  const resumeOptions = (options, route, rounds, effortMode, instructions, effectiveStrategy = executionStrategy) => ({ captureOptions: options, route, runtime: REVIEW_RUNTIME, instructionsHash: hash(instructions), execution: { reviewEffort:effortMode, enableCounterVerification, executionStrategy:effectiveStrategy, maxInputBytes, wholeScopeConcurrency, rounds, enableRiskPlanning, skipSmallRiskPlans, enableBusinessGrouping, enableAnchorCorrection, changesConcurrency, maxRetrievalRounds, riskPlanningMode, readerBudgetPolicy, optimizeReviewCalls, enablePrimarySeeds, focusPrimaryContext, enableSearchSeeds, nativeOutputTools, enableGroupPrimary, enableEvidenceContext, inlineInteractionRisks, enableMigrationContracts, enableMigrationRegression, enableGroupInteractions, enableStageContinuation } });
  const previews = new Map();
  let busy = false;
  function prune() { for (const [id, p] of previews) if (p.expires <= now()) previews.delete(id); }
  return {
    async preview(args, exec) {
      exec = bind(exec);
      exec.signal.throwIfAborted();
      if (busy) throw new Error('Review service busy');
      if (!args || Object.keys(args).some(k => !['repositoryPath', 'selectedPaths', 'contextPaths', 'rulePaths', 'autoContext', 'commit', 'baseRevision', 'targetRevision','businessRequirement','callerScopePaths','oldContextPaths','reviewRounds','svnRevision','svnBaseRevision','svnTargetRevision','svnAllowNetwork','svnEffectiveMergeinfo','svnBasePath','svnTargetPath','svnReplacementBaseRevision','svnReplacementAllowNetwork','changeScope','resumeFromJobId','rereviewFromJobId','findingOutcomes','reviewEffort','rereviewScope','executionStrategy'].includes(k))) throw new Error('Unknown preview argument');
      if (args.resumeFromJobId !== undefined && (typeof args.resumeFromJobId !== 'string' || !/^[a-f0-9-]{36}$/.test(args.resumeFromJobId))) throw new Error('Invalid resume job id');
      if (args.autoContext !== undefined && typeof args.autoContext !== 'boolean') throw new Error('Invalid autoContext option');
      for (const key of ['selectedPaths', 'contextPaths', 'rulePaths', 'oldContextPaths']) if (args[key] !== undefined && (!Array.isArray(args[key]) || args[key].length > (key === 'rulePaths' ? 4 : key === 'oldContextPaths' ? 20 : 200) || args[key].some(p => typeof p !== 'string'))) throw new Error('Invalid path list');
      const rounds=validateReviewRounds(args.reviewRounds === undefined ? reviewRounds : args.reviewRounds);
      if ((args.executionStrategy ?? executionStrategy) === 'whole-scope' && (rounds !== 1 || args.resumeFromJobId !== undefined)) throw new Error('Whole-scope requires fresh single-round changes review');
      validateBusinessRequirement(args.businessRequirement);
      if (args.callerScopePaths !== undefined) validateCallerScopes(args.callerScopePaths);
      const requestedStrategy = args.executionStrategy ?? executionStrategy;
      if(!['auto','staged','whole-scope'].includes(requestedStrategy))throw new Error('Invalid requested execution strategy');
      const effortMode = args.reviewEffort ?? reviewEffort;
      if (!['auto','quick','standard','deep'].includes(effortMode)) throw new Error('Invalid review effort mode');
      if (args.rereviewFromJobId !== undefined && (typeof args.rereviewFromJobId !== 'string' || !/^[a-f0-9-]{36}$/.test(args.rereviewFromJobId) || args.resumeFromJobId !== undefined || rounds !== 1)) throw new Error('Invalid or conflicting re-review source');
      if (args.findingOutcomes !== undefined && (!Array.isArray(args.findingOutcomes) || args.findingOutcomes.length > 200 || args.rereviewFromJobId === undefined)) throw new Error('Finding outcomes require bounded explicit re-review');
      if(args.rereviewScope!==undefined&&(!['full','diff-only'].includes(args.rereviewScope)||args.rereviewFromJobId===undefined))throw new Error('Explicit re-review scope requires owned prior review');
      const current = owner(exec);
      busy = true;
      try {
        const options = structuredClone(args);
        const rereviewJobId = options.rereviewFromJobId, findingOutcomes = options.findingOutcomes, explicitDiffOnly = options.rereviewScope === 'diff-only';
        delete options.rereviewFromJobId; delete options.findingOutcomes; delete options.reviewEffort; delete options.rereviewScope; delete options.executionStrategy;
        let previousHistory;
        if (rereviewJobId !== undefined) {
          if (typeof exec.resolvePriorReview !== 'function') throw new Error('Owned prior review requires a new background preview');
          previousHistory = await exec.resolvePriorReview(rereviewJobId);
        }
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
        const effort = reviewEffortPolicy(snapshot,{mode:effortMode});
        const history = prepareReviewHistory(snapshot,current.route,{...options,reviewEffort:effortMode,executionStrategy:requestedStrategy,enableCounterVerification},{previous:previousHistory,outcomes:findingOutcomes,explicitDiffOnly});
        const instructions = REVIEW_INSTRUCTIONS + '\nReview focus (not proof, no additional authority): ' + JSON.stringify(effort.checks);
        let resumeState;
        const readerBudget = reviewReaderBudget(snapshot, readerBudgetPolicy);
        const candidateSnapshot = history.selection?.reviewSnapshot ?? snapshot;
        const planningScope = configureWireBudget(createRetrievalScope(snapshot, { ...readerBudget, signal:exec.signal, ...(optimizeReviewCalls?{reuseResults:true}:{}) }),{nativeOutputTools});
        const wholePlan = requestedStrategy!=='staged' && rounds===1 && !sourceJobId ? prepareWholeScope(candidateSnapshot,{instructions,scope:planningScope,maxInputBytes}) : undefined;
        const dispatch = resolveReviewDispatch({requested:requestedStrategy,mode:'changes',rounds,resume:!!sourceJobId,wholePlan,hostAvailable:hostChildren?.capability?.()===true,concurrency:wholeScopeConcurrency,sourceBytes:Buffer.byteLength(JSON.stringify(snapshot))});
        const effectiveStrategy=dispatch.effectiveStrategy;
        resumeState=savedResume===undefined?undefined:validateResumeState(savedResume,snapshot,resumeOptions(options,current.route,rounds,effortMode,instructions,effectiveStrategy));
        const plan = buildCoveragePlan(candidateSnapshot, { executionStrategy:effectiveStrategy, enableEvidenceContext, inlineInteractionRisks, enableMigrationContracts, enableMigrationRegression, enableGroupInteractions, enableStageContinuation, enableGroupPrimary, resumeState, focusPrimaryContext, riskPlanningMode, enableRiskPlanning, skipSmallRiskPlans, reviewRounds:rounds, enableBusinessGrouping, instructions, scope: configureWireBudget(createRetrievalScope(snapshot, { ...readerBudget, signal: exec.signal, ...(optimizeReviewCalls ? { reuseResults: true } : {}) }), { nativeOutputTools }), grouping: buildReviewGroups(snapshot.files, inferFileRelations(snapshot.files)), maxInputBytes, signal: exec.signal });
        const useHostChildren = dispatch.childMode === 'host-subagents';
        if (useHostChildren) await hostChildren.prepare();
        prune();
        while (previews.size >= maxPreviews) previews.delete(previews.keys().next().value);
        const previewId = randomUUID();
        const expires = now() + ttlMs;
        previews.set(previewId, { ...current, target, options, rounds, snapshotId: snapshot.id, resumeState, sourceJobId, useHostChildren, effort, instructions, history, rereviewJobId, dispatch, effectiveStrategy, expires });
        return {
  ...(options.businessRequirement !== undefined
    ? { businessRequirement: { text: options.businessRequirement, hash: hash(options.businessRequirement), bytes: Buffer.byteLength(options.businessRequirement) } }
    : {}),
  previewId,
  expiresAt: new Date(expires).toISOString(),
  validForMs: ttlMs,
  ...(resumeState ? { resume: resumePreview(resumeState, sourceJobId) } : {}),
  plan,
  dispatch,
  reviewEffort: effort,
  ...(rereviewJobId ? { rereview: { sourceJobId:rereviewJobId,cycle:history.previous.cycle+1,maxCycles:3,incremental:history.incremental,notice:'Historical metadata only; no prior approval, conclusions or receipts are reused. Navigation paths are not coverage.' } } : {}),
  snapshotId: snapshot.id,
  privateArtifacts: { enabled: typeof exec.onModelArtifact === 'function', sourceBearing: true, maxArtifactBytes: 1048576, maxJobBytes: 8388608, maxArtifacts: 4096, notice: 'Background jobs retain bounded untrusted model output outside the reviewed workspace; omissions/truncation explicit. Never included in ordinary status or reused as evidence; explicit consent required to read.' },
  execution: { executionStrategy:effectiveStrategy, counterVerification: enableCounterVerification && effort.counterVerification.eligible, ...(effectiveStrategy === 'whole-scope' ? { resumeSupported: false, maxInputBytes, batchExecution: useHostChildren ? 'host-subagents' : 'direct', batchConcurrency: useHostChildren ? Math.min(wholeScopeConcurrency, plan.primaryGroups.length) : 1 } : {}), nativeOutputTools, enableGroupPrimary, enableEvidenceContext, inlineInteractionRisks, enableMigrationContracts, enableMigrationRegression, enableGroupInteractions, enableStageContinuation, fileConcurrency: changesConcurrency, maxRetrievalRounds, ...(optimizeReviewCalls ? { riskPlanningMode, readerBudget: { policy: readerBudgetPolicy, ...readerBudget }, missingContextSeeds: enablePrimarySeeds, focusPrimaryContext, searchContextSeeds: enableSearchSeeds } : {}) },
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
  notice: effectiveStrategy === 'whole-scope' ? '整体优先主审：批准完整双侧按实际输入字节合批；不执行逐文件风险规划、业务分组或旧专门综合。候选集中独立复核；补读可增加调用，共享读取账本不重置。超大文件明确阻断，多批跨边界未核查保持部分完成；不承诺一次请求或审查通过。不支持旧阶段恢复或多轮。' + (useHostChildren ? ` 超限多组使用真实spawn子智能体，最多${wholeScopeConcurrency}组并行，每组保留独立持续上下文，仅批准快照读取工具；逐模型生成尝试共用总账，逻辑LLM输入预算不代表最终HTTP字节。` : '') : buildPreviewNotice(snapshot, options, enableRiskPlanning, changesConcurrency, maxRetrievalRounds) + (enableMigrationContracts ? ' 迁移契约仅由批准快照的明确旧/新入口与调用绑定产生，无法解析的语言结构保持未解决，不以相似名称推断迁移。' : '') + (enableMigrationRegression ? ' 显式跨文件旧新比较仅在host契约限定来源和本次独立回执齐备时成立，因果仍未证明。' : '') + (enableGroupInteractions ? ' 组主审可附带交互结果，只有当前代全组编辑实读且host校验通过时替代匹配专门阶段；缺失/非法回退，候选仍独立复核。' : '') + (enableStageContinuation ? ' 未完成阶段可在其他阶段释放额度后有限继续，不重置总账或原超时；已验收主审生成可精确续用，但复核重新读取、新回执，不继承旧证据。' : '') + (enableEvidenceContext ? ' 可将本次实际交付过的批准原行按相关性经当前阶段reader有限重新投递；缓存仍计交付字节，不继承历史读取覆盖或复核回执。' : '') + (inlineInteractionRisks ? ' 预算适配的精确跨文件单元可在交互主审同次返回风险假设，省去独立规划；缺失或无效风险不补发、不代表已完成风险核查。' : '') + (optimizeReviewCalls ? ` 完整正文或覆盖全部精确编辑的单批窗口可将风险问题合并入主审（非独立规划）；仅对批准上下文的确定坐标预取小片段，不代表完整核查。${focusPrimaryContext ? " 主审优先保留主文件全文，仅附带有关联的有界完整上下文；其余批准来源保留目录按需读，不表示不存在或已核查。" : ""}${enableSearchSeeds ? " 可将模型搜索命中的批准原行小片段与搜索结果同轮提供，每阶段最多2次额外读取，共用原预算；不猜测另侧坐标，不增加检索轮次。" : ""}共享检索上限按本次范围计算：${readerBudget.maxCalls}次唯一操作结果生成／${readerBudget.maxOutputBytes}交付字节，所有阶段共用、不逐文件重置；同快照相同请求可复用原始结果，每次交付仍计字节并重新签发复核回执；主审、综合及复核按权重预留最低额度，未用额度释放，额度不足仍如实标记未完成。` : ''),
};
      } finally { busy = false; }
    },
    async execute(args, exec) {
      exec = bind(exec);
      exec.signal.throwIfAborted();
      if (busy) throw new Error('Review service busy');
      if (!allowModelSending) throw new Error('Model sending is disabled by plugin configuration');
      if (!args || Object.keys(args).some(k => !['previewId', 'confirmed'].includes(k)) || args.confirmed !== true || typeof args.previewId !== 'string') throw new Error('Confirmed preview is required');
      const current = owner(exec), preview = previews.get(args.previewId);
      try { previewValidity(preview, current, now()); }
      catch (error) { if (error.code === 'PREVIEW_EXPIRED') previews.delete(args.previewId); throw error; }
      prune();
      busy = true;
      previews.delete(args.previewId);
      try {
        const target = await resolveWorkspaceRepository(current.cwd, preview.options.repositoryPath);
        if (target !== preview.target) throw new Error('Repository target changed; preview again');
        const snapshot = await capture(target, { ...preview.options, signal: exec.signal });
        exec.signal?.throwIfAborted();
        if (snapshot.id !== preview.snapshotId || owner(exec).cwd !== current.cwd) throw new Error('Files changed since preview; preview again');
        if (preview.useHostChildren && !hostChildren?.capability()) throw new Error('Approved child execution capability changed; preview again');
        const resumeIdentity = resumeOptions(preview.options, preview.route, preview.rounds, preview.effort.mode, preview.instructions, preview.effectiveStrategy);
        const resumeState = preview.resumeState ? validateResumeState(preview.resumeState, snapshot, resumeIdentity) : undefined;
        if (await authorize({ snapshot, route: preview.route, exec }) !== true) throw new Error('Model sending approval denied or unavailable');
        exec.signal?.throwIfAborted();
        if (owner(exec).cwd !== current.cwd || JSON.stringify(owner(exec).route) !== JSON.stringify(preview.route)) throw new Error('Agent changed during approval');
        await exec.reviewCheckpoint?.({stage:'approved-manifest',snapshotId:snapshot.id,files:snapshot.files.map(f=>({fileId:f.id,path:f.path,status:f.eligibility==='reviewable'?'pending':f.eligibility}))});
        const report = await reviewSnapshot(preview.history.selection?.reviewSnapshot ?? snapshot, createDshModel(llm, preview.route,{correctJson:true,useNativeTools:nativeOutputTools}), { approvedRetrievalSnapshot: snapshot, instructions: preview.instructions, reviewEffort: preview.effort, enableCounterVerification: enableCounterVerification && preview.effort.counterVerification.eligible, executionStrategy:preview.effectiveStrategy, maxInputBytes, wholeScopeConcurrency, childExecution: preview.useHostChildren ? 'host-subagents' : undefined, createBatchModel: preview.useHostChildren ? args => hostChildren.create({ ...args, parent: exec.agent, route: preview.route, cwd: target }) : undefined, signal: exec.signal, enableRetrieval: true, enableGrouping: true, enableGroupPrimary, enableEvidenceContext, inlineInteractionRisks, enableMigrationContracts, enableMigrationRegression, enableGroupInteractions, enableStageContinuation, nativeOutputTools, enableVerification: true, riskPlanningMode, readerBudgetPolicy, optimizeReviewCalls, enablePrimarySeeds, focusPrimaryContext, enableSearchSeeds, enableRiskPlanning, skipSmallRiskPlans, reviewRounds:preview.rounds, enableBusinessGrouping, enableAnchorCorrection,changesConcurrency,maxRetrievalRounds,correctProtocol:true, onProgress:exec.reviewCheckpoint, resumeState, onModelArtifact: exec.onModelArtifact, onResumeCheckpoint: exec.reviewResumeCheckpoint ? async checkpoint => { await exec.reviewResumeCheckpoint(buildResumeState(snapshot, resumeIdentity, checkpoint)); } : undefined });
        if (preview.history.selection?.plan.requiredReportStatus === 'partial') { if (report.status==='completed') report.status='partial'; report.limitations.push({text:'增量复审只检查本轮选定主文件；未重审文件仅作批准检索上下文，不代表完整范围已查完。'}); }
        report.dispatch = preview.dispatch;
        report.model = preview.route;
        report.reviewEffort = preview.effort;
        report.reviewHistory = finishReviewHistory(report,preview.history);
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
        return { report, markdown:renderUserReport(report), technicalMarkdown:markdownReport(report) };
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
