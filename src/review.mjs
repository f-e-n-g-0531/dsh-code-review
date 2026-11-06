import { approvedRetrievalSnapshot } from './approved-retrieval.mjs';
import { REVIEW_INSTRUCTIONS, PROJECT_REVIEW_INSTRUCTIONS } from './prompts.mjs';
import { reviewWholeScope } from './whole-scope-review.mjs';
import { reviewRounds } from './review-rounds.mjs';
import { correctAnchor } from './anchor-correction.mjs';
import { correctedResponse } from './response-correction.mjs';
import { validateBusinessRequirement } from './business-requirement.mjs';
import { riskReadCoverage } from './risk-read-coverage.mjs';
import { BUSINESS_GROUP_INSTRUCTIONS, localBusinessGroups, prepareBusinessGroups, validateBusinessGroups } from './business-groups.mjs';
import { RISK_PLAN_INSTRUCTIONS, riskPlanningDecision, validateRiskPlan } from './risk-plan.mjs';
import { prepareInteractionInput } from './interaction-input.mjs';
import { validateInteractionFindings } from './interaction-findings.mjs';
import { initialInputBudget } from './input-budget.mjs';
import { validateWindowFindings } from './window-findings.mjs';
import { groupDuplicateFindings } from './finding-groups.mjs';
import { validateSynthesisReads } from './synthesis-evidence.mjs';
import { hash } from './content.mjs';
import { coverageFollowup } from './coverage-followup.mjs';
import { verificationLoop } from './verification-loop.mjs';
import { runCounterVerification } from './counter-verification.mjs';
import { inferFileRelations } from './file-relations.mjs';
import { buildReviewGroups } from './review-groups.mjs';
import { changeMap } from './change-map.mjs';
import { createRetrievalScope } from './retrieval-scope.mjs';
import { retrievalLoop, retrievalRequest } from './retrieval-loop.mjs';
import { reviewDiagnostics, diagnosticsMarkdown } from './review-diagnostics.mjs';
import { preparePrimaryInput } from './primary-input.mjs';
import { validateAttribution } from './attribution.mjs';
import { changeScopeLabel } from './git-change-scope.mjs';
import { canonicalRiskInput } from './risk-scope.mjs';
import { changesConcurrency, retrievalRounds, verificationRetrievalRounds } from './review-execution-policy.mjs';
import { scheduleFileChains } from './file-chain-scheduler.mjs';
import { reviewReaderBudget, readerAdmission } from './review-reader-policy.mjs';
import { primarySeeds } from './primary-seeds.mjs';
import { createReviewReaderAllocation } from './review-reader-allocation.mjs';
import { prepareGroupPrimary, validateGroupPrimary } from './group-primary.mjs';
import { configureWireBudget, modelWireBudget } from './model-wire-budget.mjs';
import { createEvidenceContext } from './evidence-context.mjs';
import { prepareInteractionRisk, consumeInteractionRisks } from './interaction-risk.mjs';
import { reportSummaryMarkdown } from './report-summary.mjs';
import { findingsMarkdown } from './report-findings.mjs';
import { readabilityMarkdown, limitationDetailsMarkdown } from './report-readability.mjs';
import { validateGroupInteraction } from './group-interaction.mjs';
import { stageKey } from './review-stage-state.mjs';
import { createStageGenerationCache } from './stage-generation-cache.mjs';
import { reviewChangeMap } from './review-change-map.mjs';
import { createStageContinuation } from './stage-continuation.mjs';
import { buildMigrationContracts } from './migration-contracts.mjs';

export { REVIEW_INSTRUCTIONS };
export function createReviewReader(snapshot, options = {}) {
  return configureWireBudget(createRetrievalScope(approvedRetrievalSnapshot(snapshot, options.approvedRetrievalSnapshot), { ...reviewReaderBudget(snapshot, options.readerBudgetPolicy ?? 'fixed'), signal: options.signal, ...(options.optimizeReviewCalls ? { reuseResults: true } : {}) }), { nativeOutputTools: options.nativeOutputTools === true });
}
export { PROJECT_REVIEW_INSTRUCTIONS };
const nonempty = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 8000;
const lines = text => text.replaceAll('\r\n', '\n').split('\n');
const protocolError = (code, message) => Object.assign(new Error(message), { code });

export function validateFindings(response, file) {
  return validateResponse(response, file);
}

export function validateResponse(response, file, knownChanges) {
  if (Buffer.byteLength(typeof response === 'string' ? response : JSON.stringify(response) ?? '') > 128 * 1024) throw new Error('Review response too large');
  if (typeof response === 'string') response = JSON.parse(response);
  if (!response || !Array.isArray(response.findings) || response.findings.length > 50 || !Array.isArray(response.limitations) || response.limitations.length > 50 || response.limitations.some(s => !nonempty(s))) throw protocolError('MODEL_INVALID_REVIEW_RESPONSE', 'Invalid review response');
  const changes = knownChanges ?? reviewChangeMap(file.left.text, file.right.text);
  const findings = response.findings.map(raw => {
    if (!raw || raw.fileId !== file.id) throw protocolError('MODEL_INVALID_FINDING_IDENTITY', 'Invalid finding identity or severity');
    if (!['critical', 'high', 'medium', 'low'].includes(raw.severity)) throw protocolError('MODEL_INVALID_FINDING_SEVERITY', 'Invalid finding identity or severity');
    for (const key of ['title', 'evidence', 'trigger', 'impact', 'suggestion']) if (!nonempty(raw[key])) throw protocolError('MODEL_MISSING_FINDING_FIELD', 'Missing finding field: ' + key);
    const anchor = raw.anchor;
    if(file.reviewMode==='project'&&(anchor?.side==='old'||anchor?.kind==='property'))throw new Error('Project findings require current source evidence');
    if (!anchor || !['line', 'property', 'file'].includes(anchor.kind)) throw protocolError('MODEL_INVALID_ANCHOR', 'Invalid anchor');
    let validated;
    if (anchor.kind === 'line') {
      const side = anchor.side === 'old' ? file.left : anchor.side === 'new' ? file.right : null;
      if (!side || !Number.isSafeInteger(anchor.start) || !Number.isSafeInteger(anchor.end) || anchor.start < 1 || anchor.end < anchor.start || !nonempty(anchor.snippet)) throw protocolError('MODEL_INVALID_ANCHOR', 'Invalid line anchor');
      const source = lines(side.text);
      if (anchor.end > source.length || source.slice(anchor.start - 1, anchor.end).join('\n') !== anchor.snippet.replaceAll('\r\n', '\n')) throw protocolError('MODEL_ANCHOR_MISMATCH', 'Finding snippet does not match snapshot');
      validated = { kind: 'line', side: anchor.side, start: anchor.start, end: anchor.end, snippet: anchor.snippet };
    } else if (anchor.kind === 'property') {
      if (!file.properties.some(p => p.name === anchor.name)) throw new Error('Unknown changed property');
      validated = { kind: 'property', name: anchor.name };
    } else validated = { kind: 'file' };
    const result = { fileId: file.id, path: file.path, severity: raw.severity, anchor: validated, attribution:file.reviewMode==='project'?{status:'not-applicable',causality:'current-source-only'}:validateAttribution(raw.attribution, file, changes) };
    for (const key of ['title', 'evidence', 'trigger', 'impact', 'suggestion']) result[key] = raw[key];
    return { id: hash(JSON.stringify(result)), ...result };
  });
  return { findings: [...new Map(findings.map(f => [f.id, f])).values()], limitations: response.limitations };
}

async function invoke(model, request, timeoutMs, parentSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal.reason);
  parentSignal?.addEventListener('abort', abort, { once: true });
  if (parentSignal?.aborted) abort();
  const timer = timeoutMs>0?setTimeout(() => controller.abort(Object.assign(new Error('Model timeout'), { code: 'MODEL_TIMEOUT' })), timeoutMs):undefined;
  try {
    controller.signal.throwIfAborted();
    // Executors must honor cancellation; never release ownership before cleanup settles.
    const result = await model({ ...request, signal: controller.signal });
    controller.signal.throwIfAborted();
    return result;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abort);
  }
}

export async function reviewSnapshot(snapshot, model, options = {}) {
  if (options.executionStrategy === 'whole-scope') return reviewWholeScope(snapshot, model, { ...options, instructions: options.instructions ?? REVIEW_INSTRUCTIONS, validateFindingResponse: validateResponse });
  if (options.executionStrategy !== undefined && options.executionStrategy !== 'staged') throw new Error('Invalid review execution strategy');
  const startedAt = performance.now();
  const rounds = reviewRounds(options.reviewRounds);
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const { maxInputBytes = 96 * 1024, maxCalls = Number.MAX_SAFE_INTEGER, timeoutMs = 0 } = options;
  // Low-level callers retain serial compatibility; the production changes service opts into two chains.
  const fileConcurrency = changesConcurrency(options.changesConcurrency ?? 1);
  const maxRetrievalRounds = retrievalRounds(options.maxRetrievalRounds);
  const maxVerificationRetrievalRounds = verificationRetrievalRounds(options.maxVerificationRetrievalRounds, maxRetrievalRounds);
  let checkpointFailed = false, checkpointFailure;
  const progress = options.onProgress;
  const resumeCheckpoint = options.onResumeCheckpoint;
  if (resumeCheckpoint) options = { ...options, onResumeCheckpoint: async report => { try { await resumeCheckpoint(report); } catch (error) { checkpointFailed = true; checkpointFailure = error; controller.abort(error); throw error; } } };
  options = { ...options, onProgress: progress ? async event => {
    if (checkpointFailed) throw checkpointFailure;
    try { await progress(structuredClone(event)); }
    catch (error) { checkpointFailed = true; checkpointFailure = error; controller.abort(error); throw error; }
  } : undefined };
  if (typeof model !== 'function') throw new Error('A model executor is required');
  for(const n of [maxInputBytes,maxCalls])if(!Number.isSafeInteger(n)||n<1)throw new Error('Invalid review limit');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<0)throw new Error('Invalid review limit');
  // Clone once: callers cannot change the input while a model call is pending.
  const input = structuredClone(snapshot);
  const instructions=options.instructions ?? (input.projectScope?PROJECT_REVIEW_INSTRUCTIONS:REVIEW_INSTRUCTIONS);
  if (!input || !nonempty(input.id) || !['git', 'svn'].includes(input.vcs) || !Array.isArray(input.files) || input.files.length > 200) throw new Error('Invalid review snapshot');
  const identities = new Set(), paths = new Set();
  for (const file of input.files) {
    if (!file || !nonempty(file.id) || identities.has(file.id) || !nonempty(file.path) || paths.has(file.path) || !['reviewable', 'excluded', 'blocked'].includes(file.eligibility)) throw new Error('Invalid or duplicate snapshot file');
    identities.add(file.id); paths.add(file.path);
    if (file.eligibility === 'reviewable' && (typeof file.left?.text !== 'string' || typeof file.right?.text !== 'string' || !Array.isArray(file.properties))) throw new Error('Missing review content');
  }
  if (options.enableBusinessGrouping === true && options.enableRetrieval !== true) throw new Error('Business grouping requires approved retrieval scope');
  if (options.enableVerification === true && options.enableRetrieval !== true) throw new Error('Verification requires approved retrieval scope');
  for (const key of ['enableEvidenceContext', 'inlineInteractionRisks', 'enableMigrationContracts', 'enableMigrationRegression', 'enableModelComparison', 'enableGroupInteractions', 'enableStageContinuation']) if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new Error('Invalid review optimization option');
  const evidenceContext = options.enableEvidenceContext === true ? createEvidenceContext(input.id) : null;
  const readerLimits = reviewReaderBudget(input, options.readerBudgetPolicy ?? 'fixed');
  const scope = options.enableRetrieval === true ? createRetrievalScope({ ...approvedRetrievalSnapshot(input, options.approvedRetrievalSnapshot), context: input.context ?? [] }, { ...readerLimits, signal, ...(options.optimizeReviewCalls === true ? { reuseResults: true } : {}) }) : null;
  const report = { schemaVersion: 1, snapshotId: input.id, vcs: input.vcs, status: 'completed', files: [], findings: [], limitations: [], modelCalls: 0 };
  validateBusinessRequirement(input.businessRequirement);
  if(input.businessRequirement!==undefined)report.businessRequirement={hash:hash(input.businessRequirement),bytes:Buffer.byteLength(input.businessRequirement),status:'untrusted-constraint'};
  if (input.callerDiscovery) {
    report.callerDiscovery = structuredClone(input.callerDiscovery);
    report.limitations.push({text:'调用者发现仅限批准目录内字面引用，不证明函数调用或完整覆盖；仅已捕获上下文可用于证据。'});
    if (input.callerDiscovery.candidates.some(c=>c.status==='blocked')) report.limitations.push({text:'部分引用方因上下文名额限制未捕获。'});
  }
  if (input.autoContext) {
    report.autoContext = structuredClone(input.autoContext);
    if (input.autoContext.truncated || input.autoContext.candidates.some(c => c.status === 'blocked')) report.limitations.push({ text: '自动上下文未完全捕获：存在截断或阻塞，仅实际捕获路径可用于证据。' });
  }
  if(input.projectScope)report.projectScope=structuredClone(input.projectScope);
  if (input.history) report.history = structuredClone(input.history);
  if (input.changeScope) report.changeScope = input.changeScope;
  if (input.mergeSources) report.mergeSources = structuredClone(input.mergeSources);
  if(input.workingScope)report.workingScope=structuredClone(input.workingScope);
  if(input.effectiveMergeSources)report.effectiveMergeSources=structuredClone(input.effectiveMergeSources);
  report.rules = (input.rules ?? []).map(({ path, hash }) => ({ path, hash }));
  if (scope) configureWireBudget(scope, { nativeOutputTools: options.nativeOutputTools === true });
  if (options.enableMigrationContracts === true && scope && !input.projectScope) {
    report.migrationContracts = buildMigrationContracts(input);
  }
  if (options.enableGrouping === true || report.migrationContracts?.contracts.length) report.grouping = buildReviewGroups(input.files, [...inferFileRelations(input.files), ...(report.migrationContracts?.links ?? []).map(link => ({ from: link.from, to: link.to, reason: link.reasons?.join(',') ?? 'migration-contract' }))]);
  report.interactions = [];
  const selectedGroups = (report.grouping?.groups ?? []).filter(group => group.fileIds.length > 1);
  if (report.migrationContracts) report.migrationContracts.groups = selectedGroups.filter(group => report.migrationContracts.groups.some(other => [...other.fileIds].sort().join(',') === [...group.fileIds].sort().join(',')));
  const interactionPlans = scope ? selectedGroups.map(group => ({ group, prepared: prepareInteractionInput(input, group, payload => initialInputBudget({ instructions, input: payload, maxRetrievalRounds }, scope, maxInputBytes)) })) : [];
  for (const plan of interactionPlans.filter(p => p.prepared.status !== 'not-applicable')) report.interactions.push({ groupId: plan.group.id, fileIds: plan.prepared.fileIds, status: plan.prepared.status === 'ready' ? 'pending' : 'blocked', reason: plan.prepared.reason, lifecycle: 'shares-last-primary-timeout' });
  const fileResults = new Array(input.files.length);
  const sharedState = report.orchestration = { modelMetrics: {}, modelCallPurposes: {} };
  const retainArtifact = options.onModelArtifact ? async artifact => { const reference = await options.onModelArtifact(artifact); if (reference) (report.artifacts ??= []).push(reference); } : undefined;
  report.resume = { reusedFiles: options.resumeState?.completed?.length ?? 0 };
  const reserveShared = ({ correction = false } = {}) => {
    if (!correction && options.remainingCalls?.() <= 0) throw Object.assign(new Error('Shared project model call limit exceeded'), { code: 'PROJECT_MODEL_CALL_LIMIT' });
    if (report.modelCalls >= maxCalls) throw new Error('Model call budget exceeded');
    report.modelCalls++;
  };
  const sharedModel = async request => {
    let correction;
    return model({ ...request, nativeOutputTools: options.nativeOutputTools === true, maxInputBytes: options.nativeOutputTools === true ? maxInputBytes : request.maxInputBytes, onModelArtifact: retainArtifact ? artifact => retainArtifact({ ...artifact, snapshotId: input.id, phase: request.reviewPhase }) : undefined,
      onProtocolEvent: async info => { if (info.action === 'json-transport-recovery') (sharedState.modelRecoveries ??= []).push(info); await request.onProtocolEvent?.(info); },
      onProtocolCorrection: async info => { reserveShared({ correction: true }); correction = info; await request.onProtocolCorrection?.(info); },
      onModelEvent: async info => {
        if (info.action === 'model-end') {
          const phase = request.reviewPhase, metrics = sharedState.modelMetrics[phase] ??= { calls: 0, durationMs: 0, inputBytes: 0, totalOutputBytes: 0 };
          metrics.calls++; metrics.durationMs += info.durationMs; metrics.inputBytes += info.inputBytes; metrics.totalOutputBytes += info.totalOutputBytes;
          if (info.callPurpose) sharedState.modelCallPurposes[info.callPurpose] = (sharedState.modelCallPurposes[info.callPurpose] ?? 0) + 1;
          if (info.callPurpose === 'json-correction' && correction) { (sharedState.modelCorrections ??= []).push({ action: 'explicit-json-correction', code: 'MODEL_INVALID_JSON', jsonIssue: correction.jsonIssue }); correction = undefined; }
        }
        await options.onProgress?.({ stage: info.action, snapshotId: input.id, phase: request.reviewPhase, ...info });
      } });
  };
  const groupPrepared = new Map(), groupResults = new Map(), groupStarted = new Map(), groupInteractions = new Map();
  const generationCache = createStageGenerationCache(input, options.resumeState?.stageGenerations ?? []);
  const acceptedStages = new Map(generationCache.records().filter(record => record.phase === 'primary').map(record => [record.key, { generation: record.generation, record, restored: true }]));
  const primarySuspensions = new Map(), correctedStages = new Set();
  const deferredStages = [], yieldedUnits = new Set(), queuedStageUnits = new Set(), fileDeadlines = new Map(), primaryStageKeys = new Map();
  const checkpointStages = () => {
    if (!options.enableStageContinuation) return;
    report.stageGenerations = generationCache.records().filter(record => record.phase === 'primary');
  };
  let readerAllocation;
  const stageScope = id => readerAllocation
    ? configureWireBudget(readerAllocation.scope(id), { nativeOutputTools: options.nativeOutputTools === true }) : scope;
  const releaseStage = id => { if (!yieldedUnits.has(id) && !queuedStageUnits.has(id) && !deferredStages.some(stage => !stage.done && stage.allocationId === id)) readerAllocation?.release(id); };
  const contextSeeds = (reader, request, existing = [], buildRequest = records => retrievalRequest(request, reader, records)) => {
    if (!evidenceContext || !reader || maxRetrievalRounds === 0) return [];
    const payload = JSON.parse(request.input), catalog = reader.catalog();
    const members = [payload, ...(payload.reviews ?? [])];
    const fileIds = new Set(members.flatMap(member => [member.file?.id, ...(member.files ?? []).map(item => item.fileId), ...(member.relatedFiles ?? []).map(item => item.id)]).filter(Boolean));
    const paths = new Set(members.flatMap(member => (member.contextRelations ?? []).flatMap(item => [item.fromPath, item.toPath])).filter(Boolean));
    for (const caller of members.flatMap(member => member.callerBindings ?? [])) if (caller.path) paths.add(caller.path);
    const riskIds = new Set(members.flatMap(member => (member.riskPlan ?? []).flatMap(item => item.sourceIds ?? [])));
    const sourceIds = catalog.filter(source => fileIds.has(source.fileId) || paths.has(source.path) || riskIds.has(source.id)).map(source => source.id).slice(0, 200);
    return evidenceContext.seed(reader, request, { sourceIds, existing, maxInputBytes, buildRequest });
  };
  const groupResult = async group => {
    if (!groupResults.has(group.id)) {
      groupStarted.set(group.id, performance.now());
      groupResults.set(group.id, invoke(async request => {
      const prepared = groupPrepared.get(group.id), groupScope = stageScope('group:' + group.id); const limits = [], reads = [];
      const groupRequest = { ...request, nativeOutputTools: options.nativeOutputTools === true, input: prepared.payload, instructions: prepared.instructions, reviewPhase: 'group-primary' };
      let response;
      try { response = await retrievalLoop(sharedModel, groupRequest, groupScope, {
        initialContext: (existing, build) => contextSeeds(groupScope, groupRequest, existing, build),
        maxRounds: maxRetrievalRounds, maxInputBytes, beforeCall: reserveShared, correctProtocol: options.correctProtocol === true,
        yieldOnBudget: options.enableStageContinuation === true,
        enableSearchSeeds: options.enableSearchSeeds === true,
        onRetrieved: records => { reads.push(...records); (sharedState.retrievalAudit ??= []).push(...records); evidenceContext?.remember(records); },
        onBudgetLimited: info => { limits.push(info); (sharedState.retrievalLimits ??= []).push(info); },
      }); } catch (error) {
        // No generation has been validated yet. Only a local reader allocation
        // failure can abandon this attempt; the root ledger is never replaced.
        const rootBudget = scope.budget();
        if (!options.enableStageContinuation || signal.aborted || request.signal?.aborted || checkpointFailed ||
            !['READER_CALL_BUDGET_EXCEEDED', 'READER_OUTPUT_BUDGET_EXCEEDED'].includes(error?.code) ||
            rootBudget.remainingCalls <= 0 || rootBudget.remainingOutputBytes <= 0 || !readerAllocation) throw error;
        const localBudget = groupScope.budget();
        const dimension = error.code === 'READER_CALL_BUDGET_EXCEEDED' ? 'remainingCalls' : 'remainingOutputBytes';
        if (localBudget[dimension] >= rootBudget[dimension]) throw error;
        // A batch which cannot fit the root is not a local allocation failure.
        if (error.pendingRequests?.length) scope.preflight(error.pendingRequests);
        (report.primaryGroupFallbacks ??= []).push({ groupId: group.id, fileIds: [...prepared.fileIds], reason: 'resumable-file-primary', code: error.code });
        return null;
      }
      const results = validateGroupPrimary(response, prepared, input, validateResponse, scope.catalog(), { enableAnchorCorrection: options.enableAnchorCorrection === true, signal: request.signal });
      const interaction = validateGroupInteraction(response, prepared, input, reads, scope.catalog());
      groupInteractions.set(group.id, interaction);
      if (interaction.status !== 'disabled') (report.groupInteractionChannels ??= []).push({ groupId: group.id, status: interaction.status, reason: interaction.reason });
      for (const generated of results.values()) {
        generated.groupLimits = structuredClone(limits);
        if (generated.groupRisk) {
          generated.groupRisk.sourceReadCoverage = riskReadCoverage(generated.groupRisk.risks, reads, scope.catalog(), input.id);
          if (generated.groupRisk.status !== 'completed') generated.limitations.push('组主审的合并风险计划缺失或无效，未补发规划调用；不表示已完成风险条件核查');
          if (generated.groupRisk.sourceReadCoverage.some(item => item.unreadSourceIds.length)) generated.limitations.push('组风险计划请求的部分来源未在本次组生成读取；不表示已核查或排除风险条件');
        }
      }
      for (const id of prepared.fileIds) releaseStage('primary:' + id);
      return results;
    }, { input: groupPrepared.get(group.id).payload, instructions: groupPrepared.get(group.id).instructions }, timeoutMs, signal));
    }
    try { return await groupResults.get(group.id); } finally { releaseStage('group:' + group.id); }
  };
  const runFile = async index => {
    const file = input.files[index];
    const state = { fileId: file.id, path: file.path, status: file.eligibility === 'reviewable' ? 'pending' : file.eligibility, reason: file.reason, ...(file.blockCode ? {blockCode:file.blockCode} : {}) };
    let result = { state, findings: [], limitations: [] };
    fileResults[index] = result;
    try {
    await options.onProgress?.({stage:'file-started',snapshotId:input.id,fileId:file.id,path:file.path,status:state.status});
    if (state.status !== 'pending') return;
    const reusable = options.resumeState?.completed?.find(row => row.fileId === file.id && row.path === file.path);
    if (reusable) {
      const prior = structuredClone(reusable.state);
      for (const key of ['modelMetrics', 'modelCallPurposes', 'modelCorrections', 'modelRecoveries', 'retrievalAudit', 'protocolAttempts', 'protocolDiagnostic', 'responseAttempts', 'responseCorrections', 'anchorCorrections', 'retrievalLimits']) delete prior[key];
      Object.assign(state, prior, { reused: true, reuseNotice: 'Prior completed evidence retained for an identical approved snapshot/configuration; no new model or evidence receipt claimed.' });
      result.findings = structuredClone(reusable.findings).map(finding => ({ ...finding, reused: true, priorRun: { snapshotId: options.resumeState.snapshotId, evidenceStatus: 'historical-verified-evidence-not-current-run-receipts' } }));
      result.limitations = structuredClone(reusable.limitations ?? []);
      return;
    }
    if (signal?.aborted) { state.status = 'cancelled'; state.reason = '用户取消'; return; }
    const assignedGroup = [...groupPrepared].find(([, value]) => value.fileIds.includes(file.id));
    if (!assignedGroup && (report.modelCalls >= maxCalls || options.remainingCalls?.() <= 0)) { state.reason = '模型调用预算耗尽'; state.failureCode = 'PROJECT_MODEL_CALL_LIMIT'; return; }
    const prepared = preparePrimaryInput(input, file, { instructions, scope, grouping: report.grouping, maxInputBytes, maxRetrievalRounds, riskPlanningMode: options.riskPlanningMode, focusPrimaryContext: options.focusPrimaryContext === true, enableRiskPlanning: options.enableRiskPlanning, skipSmallRiskPlans: options.skipSmallRiskPlans });
    const { changes, payload } = prepared;
    Object.assign(state, prepared.metadata);
    if (prepared.synthesis) state.synthesisStatus = prepared.synthesis.status === 'ready' ? 'pending' : 'blocked';
    if (prepared.synthesis?.status === 'blocked') result.limitations.push({ fileId: file.id, text: (prepared.synthesis.reason === 'batch-limit' ? '跨窗口综合批次数超过上限（20），未发送；全部主窗口仍独立审查' : '跨窗口综合输入超限，未发送') + '；单窗口完成不表示交互影响已检查' });
    if (state.sourceMode === 'change-windows') state.windowCoverage = { completed: [], pending: [...state.windowIds] };
    if(changes.precision==='envelope')result.limitations.push({fileId:file.id,text:'精确差异不可得，按保守包络分段检查；包络包含可能未变的行，不证明精确编辑或回归因果。'});
    if (changes.status === 'limited') result.limitations.push({ fileId: file.id, text: '精确变更分析受限：' + changes.reason + '；仍按完整两侧内容审查' });
    if (state.groupFallback) result.limitations.push({ fileId: file.id, text: '关联组上下文超过输入预算，回退单文件审查' });
    if (state.initialInputBytes > maxInputBytes) { state.status = 'blocked'; state.reason = '输入超过预算，未截断或提交模型'; releaseStage('primary:' + file.id); releaseStage('synthesis:' + file.id); releaseStage('verification:' + file.id); return; }
    try {
      const beforeCall = ({ reserved = false } = {}) => {
        if (!reserved && options.remainingCalls?.() <= 0) throw Object.assign(new Error('Shared project model call limit exceeded'), { code: 'PROJECT_MODEL_CALL_LIMIT' });
        if (report.modelCalls >= maxCalls) throw new Error('Model call budget exceeded');
        report.modelCalls++;
      };
      let activeReader = scope, activeStage = 'primary', activeStageLimited = false;
      const onBudgetLimited = info => {
        activeStageLimited = true;
        if (activeStage !== 'primary') (state.secondaryRetrievalLimits ??= []).push({ phase: activeStage, ...info });
        state.retrievalLimited = true;
        (state.retrievalLimits ??= []).push(info);
        result.limitations.push({ fileId: file.id, text: '检索预算受限，已保留现有结果但不能视为完整审查：' + info.reason });
      };
      let pendingStageCorrection;
      const onProtocolEvent = async info => {
        if (info.action === 'json-transport-recovery') (state.modelRecoveries ??= []).push(info);
        if (info.action === 'retrieval-protocol-correction') pendingStageCorrection = { action: info.action, code: 'RETRIEVAL_PROTOCOL_ERROR' };
        if (info.action === 'verification-response-correction' && info.code === 'MODEL_INCOMPLETE_VERIFICATION') (state.modelCorrections ??= []).push({ action: info.action, code: info.code });
        await options.onProgress?.({ stage: 'protocol-correction', fileId: file.id, path: file.path, ...info });
      };
      const trackedModel = request => {
        request.signal?.throwIfAborted();
        // The executor has admitted this call; budget-vetoed retries never reach here.
        if (pendingStageCorrection) { (state.modelCorrections ??= []).push(pendingStageCorrection); pendingStageCorrection = undefined; }
        let pendingJsonCorrection;
        return model({ ...request, nativeOutputTools: options.nativeOutputTools === true, maxInputBytes: options.nativeOutputTools === true ? maxInputBytes : request.maxInputBytes, callPurpose: request.callPurpose ?? request.reviewPhase ?? 'primary-initial', onProtocolEvent,
        onModelArtifact: retainArtifact ? artifact => retainArtifact({ ...artifact, snapshotId: input.id, fileId: file.id, path: file.path, phase: request.reviewPhase ?? 'primary' }) : undefined,
        onModelEvent: async info => {
          if (info.action === 'model-end') {
            const phase = request.reviewPhase ?? 'primary';
            if (info.callPurpose === 'json-correction' && pendingJsonCorrection) {
              (state.modelCorrections ??= []).push({ action: 'explicit-json-correction', code: 'MODEL_INVALID_JSON', ...(pendingJsonCorrection.jsonIssue ? { jsonIssue: pendingJsonCorrection.jsonIssue } : {}), phase });
              pendingJsonCorrection = undefined;
            }
            const metrics = (state.modelMetrics ??= {});
            const item = (metrics[phase] ??= { calls: 0, durationMs: 0, inputBytes: 0, totalOutputBytes: 0 });
            item.calls++; item.durationMs += info.durationMs; item.inputBytes += info.inputBytes; item.totalOutputBytes += info.totalOutputBytes;
            if (info.callPurpose) { const purposes = (state.modelCallPurposes ??= {}); purposes[info.callPurpose] = (purposes[info.callPurpose] ?? 0) + 1; }
          }
          await options.onProgress?.({ stage: info.action, snapshotId: input.id, fileId: file.id, path: file.path, phase: request.reviewPhase ?? 'primary', ...info });
        },
        onProtocolCorrection: async info => {
          beforeCall({ reserved: true });
          await request.onProtocolCorrection?.(info);
          pendingJsonCorrection = { jsonIssue: info.jsonIssue };
          await options.onProgress?.({stage:'protocol-correction',fileId:file.id,path:file.path,...info});
        },
      });
      };
      const executor = scope
        ? (request, onLimited = () => {}) => retrievalLoop(trackedModel, { ...request, nativeOutputTools: options.nativeOutputTools === true, onProtocolEvent }, activeReader, { correctProtocol:options.correctProtocol===true,maxRounds:maxRetrievalRounds,maxInputBytes, beforeCall, initialRetrieved: request.initialRetrieved ?? [], yieldOnBudget: options.enableStageContinuation === true, initialContext: (existing, build) => contextSeeds(activeReader, request, existing, build), allowExhaustedInitial: request.allowExhaustedInitial === true, enableSearchSeeds: options.enableSearchSeeds === true && !request.reviewPhase?.includes('verification'), onBudgetLimited: info => { onBudgetLimited(info); onLimited(info); }, onRetrieved: records => {
          (state.retrievalAudit ??= []).push(...records);
          evidenceContext?.remember(records);
        }, onTruncated: () => {
          if (!state.retrievalTruncated) result.limitations.push({ fileId: file.id, text: '检索结果达到数量上限，部分匹配未提供给模型' });
          state.retrievalTruncated = true;
        } })
        : request => { beforeCall(); return trackedModel(request); };
      const grouped = assignedGroup;
      const groupedGeneration = grouped ? (await groupResult({ id: grouped[0] }))?.get(file.id) : null;
      if (grouped && !groupedGeneration) {
        state.primaryGroupFallback = grouped[0];
        result.limitations.push({ fileId: file.id, text: '组主审局部检索分配不足，未接受组成果；保留已消费共享预算，回退可续跑单文件主审' });
      }
      if (groupedGeneration) {
        state.primaryGroupId = grouped[0]; state.primaryMethod = 'group-primary';
        if (groupedGeneration.anchorCorrections?.length) (state.anchorCorrections ??= []).push(...structuredClone(groupedGeneration.anchorCorrections));
        if (groupedGeneration.groupLimits?.length) {
          state.retrievalLimited = true;
          state.groupRetrievalLimits = structuredClone(groupedGeneration.groupLimits);
          result.limitations.push(...state.groupRetrievalLimits.map(limit => ({ fileId: file.id, text: '组主审检索受限：' + limit.code + '；已接受的本成员成果保留，不表示完整审查' })));
        }
        if (groupedGeneration.groupRisk) (state.riskPlans ??= []).push({ ...groupedGeneration.groupRisk, method: 'inline', scope: 'group-all-edits', groupId: grouped[0], decision: { required: true, reason: 'group-inline-primary' } });
      }
      const chainTimeout = grouped && timeoutMs > 0 ? Math.max(0, timeoutMs - (performance.now() - groupStarted.get(grouped[0]))) : timeoutMs;
      if (grouped && timeoutMs > 0 && chainTimeout <= 0) throw Object.assign(new Error('Model timeout'), { code: 'MODEL_TIMEOUT' });
      if (!fileDeadlines.has(file.id)) fileDeadlines.set(file.id, timeoutMs > 0 ? performance.now() + chainTimeout : Infinity);
      await invoke(async enclosingRequest => {
        const batches = [...(prepared.batches ?? [{ payload, windowIds: state.windowIds ?? [] }])];
        if (prepared.synthesis?.status === 'ready') batches.push({ payload: prepared.synthesis.payload, windowIds: [], synthesis: true });
        const matchingInteractionPlans = interactionPlans.filter(p => input.files.filter(f => p.group.fileIds.includes(f.id)).at(-1)?.id === file.id);
        for (const interactionPlan of matchingInteractionPlans.filter(p => p.prepared.status === 'ready')) batches.push({ payload: interactionPlan.prepared.payload, windowIds: [], interaction: interactionPlan.group });
        const scheduled = Array.from({length:rounds},(_,i)=>batches.map(b=>({...b,round:i+1}))).flat();
        primaryStageKeys.set(file.id, scheduled.filter(batch => !batch.synthesis && !batch.interaction).map(batch => stageKey(file.id, { phase: 'primary', round: batch.round, windowIds: batch.windowIds ?? [] })));
        if(rounds>1) state.reviewPasses=scheduled.map(b=>({round:b.round,windowIds:b.windowIds,...(b.interaction?{groupId:b.interaction.id}:{}),...(b.synthesis?{synthesis:true}:{}),status:'pending'}));
        const riskInput = canonicalRiskInput(input, file, prepared, { instructions: RISK_PLAN_INSTRUCTIONS, scope, maxInputBytes, maxRetrievalRounds });
        let primaryRiskPlan;
        const executeStage = async (batch, batchIndex, enclosingRequest, retry = false) => {
        enclosingRequest.signal.throwIfAborted();
        const key = stageKey(file.id, { phase: batch.interaction ? 'file-interaction' : batch.synthesis ? 'window-synthesis' : 'primary', round: batch.round, windowIds: batch.windowIds ?? [], ...(batch.interaction ? { groupId: batch.interaction.id } : {}) });
        const priorStage = acceptedStages.get(key);
        if (retry && priorStage?.completed) return;
        let cacheRejected = false;
        const allocationId = batch.interaction ? 'interaction:' + batch.interaction.id : batch.synthesis ? 'synthesis:' + file.id : 'primary:' + file.id;
        const defer = (error, unitId = allocationId) => {
          if (cacheRejected || !options.enableStageContinuation || !readerAllocation || !['READER_CALL_BUDGET_EXCEEDED', 'READER_OUTPUT_BUDGET_EXCEEDED'].includes(error?.code)) return false;
          if (!yieldedUnits.has(unitId)) { readerAllocation.yield(unitId, { reason: error.code }); yieldedUnits.add(unitId); }
          let pending = deferredStages.find(item => item.key === key);
          if (pending && pending.allocationId !== unitId) { const previousUnit = pending.allocationId; pending.allocationId = unitId; if (!deferredStages.some(other => other !== pending && !other.done && other.allocationId === previousUnit)) { yieldedUnits.delete(previousUnit); readerAllocation.release(previousUnit); } }
          if (!pending) {
            pending = { key, allocationId: unitId, fileId: file.id, phase: unitId.startsWith('verification:') ? 'verification' : phase === 'primary' ? 'primary' : phase === 'window-synthesis' ? 'synthesis' : 'interaction', fileIds: batch.interaction?.fileIds ?? [file.id], attempts: 0, run: () => invoke(next => executeStage(batch, batchIndex, next, true), { instructions, input: payload }, timeoutMs > 0 ? Math.max(1, fileDeadlines.get(file.id) - performance.now()) : 0, signal) };
            deferredStages.push(pending);
          }
          pending.requests = error.pendingRequests ?? []; pending.reason = error.code; pending.done = false;
          state.continuationPending = true;
          if (batch.interaction) Object.assign(report.interactions.find(item => item.groupId === batch.interaction.id), { status: 'pending', reason: error.code });
          if (batch.synthesis) state.synthesisStatus = 'pending';
          return true;
        };
        const phase=batch.interaction?'file-interaction':batch.synthesis?'window-synthesis':'primary';
        try{
        activeStage = phase;
        activeStageLimited = phase === 'primary' && !!groupedGeneration?.groupLimits?.length;
        // Seal the complete primary sweep before spending reads on secondary synthesis.
        // A scheduled dependency is not a reader failure and does not consume a retry.
        if (options.enableStageContinuation && !retry && (batch.synthesis || batch.interaction)) {
          if (!deferredStages.some(stage => stage.key === key)) deferredStages.push({
            key, allocationId, fileId: file.id, phase: batch.synthesis ? 'synthesis' : 'interaction',
            fileIds: batch.interaction?.fileIds ?? [file.id], attempts: 0, requests: [], reason: 'STAGE_DEPENDENCY_PENDING',
            run: () => invoke(next => executeStage(batch, batchIndex, next, true), { instructions, input: payload }, timeoutMs > 0 ? Math.max(1, fileDeadlines.get(file.id) - performance.now()) : 0, signal),
          });
          queuedStageUnits.add(allocationId);
          if (options.enableVerification) queuedStageUnits.add('verification:' + file.id);
          if (batch.synthesis) state.continuationPending = true;
          if (batch.synthesis) state.synthesisStatus = 'pending';
          if (batch.interaction) Object.assign(report.interactions.find(item => item.groupId === batch.interaction.id), { status: 'pending', reason: 'STAGE_DEPENDENCY_PENDING' });
          return;
        }
        if (options.enableStageContinuation && (batch.synthesis || batch.interaction) && (batch.interaction?.fileIds ?? [file.id]).some(id => deferredStages.some(stage => stage.fileId === id && stage.phase === 'primary' && !acceptedStages.has(stage.key)))) {
          defer(Object.assign(new Error('Stage is waiting for accepted primary generations'), { code: 'READER_CALL_BUDGET_EXCEEDED' })); return;
        }
        if (!priorStage && yieldedUnits.has(allocationId)) { defer(Object.assign(new Error('Stage is waiting for released reader capacity'), { code: 'READER_CALL_BUDGET_EXCEEDED' })); return; }
        activeReader = priorStage || groupedGeneration && !batch.synthesis && !batch.interaction ? scope : stageScope(allocationId);
        // Consuming an already validated group member performs no new source/model work.
        const combinedInteraction = batch.interaction && batch.round === 1 ? [...groupInteractions].find(([id, channel]) => channel.status === 'accepted' && JSON.stringify([...groupPrepared.get(id).fileIds].sort()) === JSON.stringify([...batch.interaction.fileIds].sort()))?.[1] : null;
        const cachedPrimary = !!priorStage || groupedGeneration && !batch.synthesis && !batch.interaction;
        const admission = !cachedPrimary && !combinedInteraction && activeReader && options.optimizeReviewCalls === true
          ? readerAdmission({ synthesis: batch.synthesis === true, interaction: !!batch.interaction, metadata: prepared.metadata }, activeReader.budget()) : { permitted: true };
        if (!admission.permitted) {
          if (defer(Object.assign(new Error('Stage reader allocation unavailable'), { code: admission.code }))) return;
          state.readerAdmission = { code: admission.code, remaining: activeReader.budget() };
          if (batch.synthesis || batch.interaction) throw Object.assign(new Error('Required evidence budget unavailable before stage admission'), { code: admission.code });
          state.reason = '检索预算不足以取得本阶段所需证据，未启动模型；需重新预览补审';
          state.failureCode = admission.code;
          state.retrievalLimited = true;
          return;
        }
        const suspended = primarySuspensions.get(key);
        let batchPayload = batch.payload;
        const relevantContracts = report.migrationContracts?.contracts.filter(contract => contract.candidateFileIds.includes(file.id) || batch.interaction?.fileIds.some(id => contract.candidateFileIds.includes(id))) ?? [];
        if (relevantContracts.length) {
          const enriched = JSON.stringify({ ...JSON.parse(batchPayload), migrationContracts: relevantContracts, migrationNotice: 'Host navigation hypotheses only; old/new entries and callers are side-qualified. Follow the complete old public gate → new entry → caller chain under the SAME trigger. Contracts do not prove semantic migration, grant sources, or replace current independent verification.' });
          if (initialInputBudget({ input: enriched, instructions, maxRetrievalRounds }, activeReader, maxInputBytes).fits) batchPayload = enriched;
          else (state.migrationContextLimitations ??= []).push('Migration navigation did not fit this stage; no coverage claim.');
        }
        const interactionStrategy = batch.interaction && !combinedInteraction ? prepareInteractionRisk(input, batch.interaction, matchingInteractionPlans.find(plan => plan.group.id === batch.interaction.id).prepared, { ...options, instructions, scope: activeReader, maxInputBytes, round: batch.round }) : null;
        const inlineInteraction = !priorStage && interactionStrategy?.mode === 'inline';
        const inlineRisk = !priorStage && (inlineInteraction || (!groupedGeneration && prepared.inlineRisk === true && batch.round === 1 && !batch.synthesis && !batch.interaction));
        const batchInstructions = inlineInteraction ? interactionStrategy.instructions : inlineRisk ? prepared.instructions : instructions;
        let riskEntry, activeRisks = [];
        if (inlineRisk && !suspended) {
          riskEntry = { status: 'pending', method: 'inline', windowIds: batch.windowIds, scope: inlineInteraction ? 'group-all-edits' : state.sourceMode === 'change-windows' ? 'all-edits' : 'full-file', ...(inlineInteraction ? { groupId: batch.interaction.id, sourceMode: 'file-interaction' } : {}), risks: [], decision: { required: true, reason: inlineInteraction ? 'inline-interaction' : 'inline-primary' } };
          (state.riskPlans ??= []).push(riskEntry);
        }
        if (options.enableRiskPlanning === true && (!groupedGeneration || batch.interaction) && !inlineRisk && !combinedInteraction && !priorStage && !suspended && !batch.synthesis && batch.round === 1) {
          const reusable = !batch.interaction && riskInput.cacheable;
          riskEntry = reusable ? primaryRiskPlan : undefined;
          if (!riskEntry) {
            const decision = options.skipSmallRiskPlans === true ? riskPlanningDecision(batch.interaction ? input.files.filter(f=>batch.interaction.fileIds.includes(f.id)) : [file]) : {required:true,reason:'unconditional'};
            riskEntry = { status: decision.required ? 'pending' : 'skipped', windowIds: reusable ? state.windowIds ?? [] : batch.windowIds, ...(reusable ? { scope: 'all-edits' } : {}), ...(batch.interaction ? {groupId:batch.interaction.id,sourceMode:'file-interaction'} : {}), risks: [], decision };
            (state.riskPlans ??= []).push(riskEntry);
            if (reusable) primaryRiskPlan = riskEntry;
            if (decision.required) {
              try {
                const planningPayload = reusable ? riskInput.payload : batch.payload;
                // Planning names unverified questions; it is not a second source investigation.
                // Leave all approved reads and independent evidence checks to the review stages.
                const planningInput = scope ? JSON.stringify({ ...JSON.parse(planningPayload), catalog: scope.catalog() }) : planningPayload;
                if (Buffer.byteLength(planningInput) + Buffer.byteLength(RISK_PLAN_INSTRUCTIONS) > maxInputBytes) throw new Error('Risk planning input budget exceeded');
                beforeCall();
                const response = await trackedModel({ ...enclosingRequest, input: planningInput, instructions: RISK_PLAN_INSTRUCTIONS, reviewPhase: 'risk-planning' });
                const riskFiles = batch.interaction ? JSON.parse(batch.payload).files : [{ fileId: file.id, edits: changes.edits ?? [] }];
                const risks = validateRiskPlan(response, riskFiles, scope?.catalog() ?? []);
                if (batch.interaction && risks.some(r=>new Set(r.editRefs.map(ref=>ref.fileId)).size<2)) throw new Error('Interaction risk requires edits across at least two files');
                riskEntry.status = 'completed'; riskEntry.risks = risks;
              } catch (error) {
                enclosingRequest.signal.throwIfAborted();
                riskEntry.status = 'fallback'; riskEntry.reason = error?.message ?? String(error);
                result.limitations.push({fileId:file.id,text:'风险计划未完成，回退原输入主审查：'+riskEntry.reason});
              }
            }
          }
          const visible = JSON.parse(batch.payload).windows;
          const visibleEdits = visible && new Set(visible.flatMap(window => window.editIds));
          activeRisks = visibleEdits ? riskEntry.risks.filter(risk => risk.editRefs.some(ref => ref.fileId === file.id && visibleEdits.has(ref.editId))) : riskEntry.risks;
          if (riskEntry.status === 'completed') {
            const enriched = JSON.stringify({ ...JSON.parse(batch.payload), riskPlan: activeRisks, riskPlanNotice: '未可信假设而非发现或证据；须验证及寻找反证，不增加读取权限。' });
            if (initialInputBudget({ instructions, input: enriched, maxRetrievalRounds }, scope, maxInputBytes).fits) batchPayload = enriched;
            else {
              activeRisks = [];
              (riskEntry.enrichmentFallbacks ??= []).push({ windowIds: batch.windowIds, reason: 'input-budget' });
              result.limitations.push({fileId:file.id,text:'风险计划扩展输入超限，本窗口保留原输入主审；未删除其他窗口的计划或主审任务'});
            }
          }
        }
        if (suspended) { batchPayload = suspended.payload; riskEntry = suspended.riskEntry; activeRisks = suspended.activeRisks; }
        if(report.modelCalls>=maxCalls && !priorStage && !combinedInteraction && !(groupedGeneration && !batch.synthesis && !batch.interaction))throw new Error('Model call budget exceeded before next review pass');
        if(rounds>1) state.reviewPasses[batchIndex].status='running';
        const request = { ...enclosingRequest, nativeOutputTools: options.nativeOutputTools === true, instructions: batchInstructions, input: batchPayload, reviewPhase: phase, allowExhaustedInitial: options.optimizeReviewCalls === true && !batch.synthesis && !batch.interaction && prepared.metadata.contextMode !== 'approved-retrieval' };
        let auditStart = suspended?.auditStart ?? state.retrievalAudit?.length ?? 0;
        const finalResponseOnly = suspended?.finalResponseOnly ?? { value: false };
        const generate = async attempt => {
          if (!initialInputBudget({ ...attempt, maxRetrievalRounds }, scope, maxInputBytes).fits) throw new Error('Review correction input budget exceeded');
          if (suspended?.resume) {
            const resume = suspended.resume; suspended.resume = undefined;
            try { return await resume(attempt.signal); }
            catch (error) { if (error.resumeRetrieval) suspended.resume = error.resumeRetrieval; throw error; }
          }
          const initialRetrieved = scope && options.enablePrimarySeeds === true && maxRetrievalRounds > 0 && !batch.synthesis && !batch.interaction
            ? primarySeeds(activeReader, attempt, { maxInputBytes, signal: attempt.signal }) : [];
          try { return await executor({ ...attempt, initialRetrieved }, () => { finalResponseOnly.value = true; }); }
          catch (error) { if (phase === 'primary' && ['READER_CALL_BUDGET_EXCEEDED', 'READER_OUTPUT_BUDGET_EXCEEDED'].includes(error?.code)) primarySuspensions.set(key, { payload: batchPayload, riskEntry, activeRisks, auditStart, finalResponseOnly, resume: error.resumeRetrieval }); throw error; }
        };
        const validate = response => {
          if (options.enableAnchorCorrection === true) {
            if (Buffer.byteLength(typeof response === 'string' ? response : JSON.stringify(response) ?? '') > 128 * 1024) throw new Error('Review response too large');
            const decoded = typeof response === 'string' ? JSON.parse(response) : structuredClone(response);
            if (Array.isArray(decoded?.findings) && decoded.findings.length <= 50) {
              decoded.findings = decoded.findings.map(raw => {
                const target = batch.interaction ? input.files.find(f => f.id === raw?.fileId && batch.interaction.fileIds.includes(f.id) && f.eligibility === 'reviewable') : file;
                if (!target) return raw;
                const correction = correctAnchor(raw, target, target === file ? changes : changeMap(target.left.text,target.right.text), { signal: request.signal });
                if (!['unchanged','not-applicable'].includes(correction.status)) (state.anchorCorrections ??= []).push(correction);
                return correction.status === 'corrected' ? correction.candidate : raw;
              });
              response = decoded;
            }
          }
          const interactionResult = inlineInteraction ? consumeInteractionRisks(response, input, batch.interaction, scope.catalog()) : null;
          const generated = batch.interaction ? validateInteractionFindings(interactionResult?.response ?? response, input, batch.interaction, (state.retrievalAudit ?? []).slice(auditStart), scope.catalog()) : validateResponse(response, file, changes);
          if (inlineInteraction) generated.interactionRisk = interactionResult.risk;
          else if (inlineRisk) { const value = typeof response === 'string' ? JSON.parse(response) : response; if (Object.hasOwn(value, 'risks')) generated.inlineRisks = value.risks; }
          if (batch.synthesis) validateSynthesisReads(generated.findings, changes, (state.retrievalAudit ?? []).slice(auditStart), scope.catalog(), file.id, input.id);
          if (!batch.interaction && state.sourceMode === 'change-windows') validateWindowFindings(generated.findings, batch.synthesis ? prepared.synthesis.windows : JSON.parse(batch.payload).windows, batch.synthesis === true);
          return generated;
        };
        const generated = priorStage ? priorStage.generation : combinedInteraction ? { findings: structuredClone(combinedInteraction.findings), limitations: structuredClone(combinedInteraction.limitations) } : groupedGeneration && !batch.synthesis && !batch.interaction ? structuredClone(groupedGeneration) : await correctedResponse(generate, validate, request, {
          enabled: options.correctProtocol === true,
          canCorrect: () => !finalResponseOnly.value && !correctedStages.has(key),
          onCorrection: async info => {
            correctedStages.add(key);
            // A fresh generation must establish its own synthesis/interaction read evidence.
            auditStart = state.retrievalAudit?.length ?? 0;
            (state.responseCorrections ??= []).push({ code: info.code, round: batch.round, phase });
            pendingStageCorrection = { action: 'review-format-correction', code: info.code, phase };
            result.limitations.push({ fileId: file.id, text: '主审响应校验失败，已请求一次显式纠正；原响应未接受，纠正不证明缺陷成立。' });
            await options.onProgress?.({ stage: 'protocol-correction', fileId: file.id, path: file.path, ...info });
          },
        });
        primarySuspensions.delete(key);
        if (inlineInteraction) {
          Object.assign(riskEntry, generated.interactionRisk);
          activeRisks = riskEntry.risks;
          if (riskEntry.limitation) result.limitations.push({ fileId: file.id, text: riskEntry.limitation });
          delete generated.interactionRisk;
        } else if (inlineRisk) {
          const response = generated.inlineRisks;
          if (response === undefined) { riskEntry.status = 'absent'; result.limitations.push({ fileId: file.id, text: '合并主审未返回风险问题，保留有效发现但不声明独立风险规划完成' }); }
          else {
            try { riskEntry.risks = validateRiskPlan({ risks: response }, [{ fileId: file.id, edits: changes.edits ?? [] }], scope?.catalog() ?? []); riskEntry.status = 'completed'; activeRisks = riskEntry.risks; }
            catch { riskEntry.status = 'invalid'; result.limitations.push({ fileId: file.id, text: '合并主审风险字段无效，保留有效发现；未额外调用模型补规划' }); }
          }
          delete generated.inlineRisks;
        }
        if (options.enableRiskPlanning === true && !priorStage && !combinedInteraction && (!groupedGeneration || batch.interaction) && !batch.synthesis && batch.round === 1) {
          const coverage = riskReadCoverage(activeRisks,(state.retrievalAudit??[]).slice(auditStart),scope?.catalog()??[],input.id);
          (riskEntry.generations ??= []).push({ round: batch.round, windowIds: batch.windowIds, coverage });
          // Preserve the single-generation field without unioning evidence across windows.
          if (riskEntry.generations.length === 1) riskEntry.sourceReadCoverage = coverage;
          else delete riskEntry.sourceReadCoverage;
          if(coverage.some(c=>c.unreadSourceIds.length)) result.limitations.push({fileId:file.id,text:'风险计划请求的部分来源未在本次生成阶段读取；不能视为已核查风险条件或排除问题'});
        }
        request.signal.throwIfAborted();
        if(rounds>1)generated.findings.forEach(f=>{f.reviewRound=batch.round;});
        if (options.enableStageContinuation && !priorStage && !activeStageLimited) {
          const record = { key, fileId: file.id, phase, round: batch.round, windowIds: batch.windowIds ?? [], ...(batch.interaction ? { groupId: batch.interaction.id } : {}), generation: { findings: structuredClone(generated.findings), limitations: structuredClone(generated.limitations) } };
          const admission = generationCache.admit(record);
          if (admission.accepted) {
            acceptedStages.set(key, { generation: generated, record: admission.record, completed: false });
            checkpointStages();
          } else {
            cacheRejected = true;
            (state.stageCacheLimits ??= []).push({ phase, round: batch.round, code: admission.code });
            result.limitations.push({ fileId: file.id, text: '阶段生成未纳入续审缓存：' + admission.code + '；保留本次有效审查结果和独立复核，不复用未缓存生成、不扩大容量。' });
          }
        }
        for (const finding of generated.findings) { const index = priorStage ? result.findings.findIndex(existing => existing.id === finding.id) : -1; if (index < 0) result.findings.push(finding); else result.findings[index] = finding; }
        if (generated.findings.some(f => f.attribution.status === 'missing')) result.limitations.push({ fileId: file.id, text: '部分发现缺少变更归因，仅校验了定位，尚不能确认属于本次回归' });
        result.limitations.push(...generated.limitations.map(text => ({ fileId: file.id, text })));
        if (!groupedGeneration && !scheduled.slice(batchIndex + 1).some(next => !next.synthesis && !next.interaction) && !deferredStages.some(stage => stage.fileId === file.id && stage.phase === 'primary' && stage.key !== key && !acceptedStages.has(stage.key))) releaseStage('primary:' + file.id);
        if (options.enableStageContinuation && !batch.interaction && !batch.synthesis && state.windowCoverage && batch.round === 1) { state.windowCoverage.completed = [...new Set([...state.windowCoverage.completed, ...batch.windowIds])]; state.windowCoverage.pending = state.windowCoverage.pending.filter(id => !batch.windowIds.includes(id)); }
        if (options.enableVerification === true && generated.findings.length && !priorStage?.completed) {
          if (yieldedUnits.has('verification:' + file.id)) {
            if (!defer(Object.assign(new Error('Verification allocation is waiting for released capacity'), { code: 'READER_CALL_BUDGET_EXCEEDED' }), 'verification:' + file.id)) {
              for (const finding of generated.findings) finding.verification = { status: 'incomplete', causality: 'unverified' };
              result.limitations.push({ fileId: file.id, text: '复核额度等待释放且生成未缓存，不能继续本阶段；候选仍未复核，不重新生成或标为完成。' });
            }
            return;
          }
          for (const finding of generated.findings) finding.verification = { status: 'pending', causality: 'unverified' };
          try {
            activeStage = 'verification';
            let verdicts = await verificationLoop(trackedModel, { ...request, onProtocolEvent, reviewPhase: 'verification' }, generated.findings, stageScope('verification:' + file.id), {
              correctProtocol:options.correctProtocol===true,maxRounds:maxVerificationRetrievalRounds,maxInputBytes, beforeCall, onBudgetLimited, yieldOnBudget: options.enableStageContinuation === true,
              enableModelComparison: options.enableModelComparison === true && !input.projectScope, enableMigrationRegression: options.enableMigrationRegression === true, migrationContracts: report.migrationContracts?.contracts ?? [], migrationSnapshot: input,
              onMigrationSeeds: event => {
                // Source-free host events only; never persist model text or reader bodies.
                if (!['accepted', 'fallback'].includes(event?.status)) return;
                const kind = ['old-delegation', 'deleted-export-route'].includes(event.kind) ? event.kind : 'entry-migration';
                const reason = ['COMPLETE_ROLE_SET', 'NO_MATCHING_CONTRACT', 'INCOMPLETE_ROLE_RANGE', 'EVIDENCE_LIMIT', 'TRANSACTION_UNAVAILABLE', 'SEED_LIMIT', 'INCOMPLETE_READ', 'FINAL_RESERVE', 'INPUT_CAPACITY', 'READER_CALL_BUDGET_EXCEEDED', 'READER_OUTPUT_BUDGET_EXCEEDED'].includes(event.reason) ? event.reason : 'OTHER';
                (state.migrationSeedEvents ??= []).push({ status: event.status, kind, reason });
              },
              onRetrieved: records => { (state.retrievalAudit ??= []).push(...records); },
              onTruncated: () => { result.limitations.push({ fileId: file.id, text: '复核检索结果达到数量上限' }); },
            });
            request.signal.throwIfAborted();
            verdicts = await runCounterVerification(trackedModel, { ...request, onProtocolEvent, reviewPhase:'verification' }, generated.findings, verdicts, stageScope('verification:' + file.id), { enabled:options.enableCounterVerification === true, enableModelComparison:options.enableModelComparison===true&&!input.projectScope,enableMigrationRegression:options.enableMigrationRegression===true,migrationContracts:report.migrationContracts?.contracts??[],migrationSnapshot:input,maxRounds:maxVerificationRetrievalRounds,maxInputBytes,beforeCall,onBudgetLimited, isFatalError:error=>checkpointFailed||error?.code==='MODEL_ARTIFACT_FAILED' });
            request.signal.throwIfAborted();
            generated.findings.forEach((finding, i) => { finding.verification = { status: verdicts[i].counterVerification?.status === 'incomplete' ? 'incomplete' : 'completed', ...verdicts[i] }; });
            if (verdicts.some(v => v.verdict === 'supported' && v.regression?.classification === 'uncertain')) result.limitations.push({ fileId: file.id, text: '部分模型支持候选缺少充分前后对照，不能确认由本次变更引入' });
            if (verdicts.some(v => v.verdict === 'uncertain')) result.limitations.push({ fileId: file.id, text: '部分候选复核仍不确定，不能视为已确认或已排除' });
          } catch (error) {
            if (error?.code === 'MODEL_ARTIFACT_FAILED') throw error;
            for (const finding of generated.findings) finding.verification = { status: 'incomplete', causality: 'unverified' };
            result.limitations.push({ fileId: file.id, text: '候选复核未完成：' + (error?.message ?? String(error)) });
            request.signal.throwIfAborted();
            if (defer(error, 'verification:' + file.id)) return;
          }
        }
        if (acceptedStages.has(key)) acceptedStages.get(key).completed = !options.enableVerification || generated.findings.every(finding => finding.verification?.status === 'completed');
        if (batch.synthesis) state.synthesisStatus = activeStageLimited ? 'pending' : 'completed';
        if (batch.interaction) {
          const interaction=report.interactions.find(p => p.groupId === batch.interaction.id);
          if (combinedInteraction) Object.assign(interaction, { method: 'group-primary-validated-channel', channelGroupId: combinedInteraction.groupId });
          if(rounds>1){interaction.completedRounds??=[];if(!activeStageLimited)interaction.completedRounds.push(batch.round);interaction.reviewRounds=rounds;}
          if(batch.round===rounds) { interaction.status = activeStageLimited || rounds > 1 && new Set(interaction.completedRounds).size !== rounds ? 'pending' : 'completed'; if (activeStageLimited) interaction.reason = state.secondaryRetrievalLimits?.at(-1)?.code ?? 'STAGE_FAILED'; }
        }
        if (state.windowCoverage && batch.round === 1) {
          state.windowCoverage.completed.push(...batch.windowIds);
          state.windowCoverage.pending = state.windowCoverage.pending.filter(id => !batch.windowIds.includes(id));
        }
        if(rounds>1)state.reviewPasses[batchIndex].status='completed';
        if (retry) { const pending = deferredStages.find(stage => stage.key === key); if (pending) { pending.succeeded = !activeStageLimited && (!options.enableVerification || generated.findings.every(finding => finding.verification?.status === 'completed')); if (activeStageLimited) pending.reason = state.retrievalLimits?.at(-1)?.code ?? 'STAGE_FAILED'; } }
        await options.onProgress?.({stage:'window-complete',snapshotId:input.id,fileId:file.id,path:file.path,windowIds:batch.windowIds,round:batch.round,findings:generated.findings,windowCoverage:state.windowCoverage});
        }catch(error){
          enclosingRequest.signal.throwIfAborted();
          if (defer(error)) return;
          if(phase==='primary'||error.code==='MODEL_ARTIFACT_FAILED')throw error;
          if (['Model call budget exceeded', 'Model call budget exceeded before next review pass'].includes(error.message) || error.code === 'PROJECT_MODEL_CALL_LIMIT') {
            result.limitations.push({ fileId: file.id, text: phase + '模型调用额度不足，尚未启动的阶段保留 pending；已完成主审成果保留' });
            return false;
          }
          const failure={phase,status:'failed',code:error.code??'REVIEW_EXECUTION_FAILED',reason:error.message,round:batch.round,...(error.attempts?{attempts:error.attempts}:{}),...(error.diagnostic?{diagnostic:error.diagnostic}:{})};
          (state.stageFailures??=[]).push(failure);
          if(batch.synthesis)state.synthesisStatus='failed';
          if(batch.interaction){const interaction=report.interactions.find(p=>p.groupId===batch.interaction.id);if(interaction)Object.assign(interaction,{status:'failed',reason:error.message,failureCode:failure.code});}
          if(rounds>1)state.reviewPasses[batchIndex].status='failed';
          result.limitations.push({fileId:file.id,text:phase+'未完成：'+error.message+'；已完成主文件/窗口成果保留，不表示综合已通过'});
          await options.onProgress?.({stage:'synthesis-failed',snapshotId:input.id,fileId:file.id,path:file.path,...failure,windowCoverage:state.windowCoverage});
        }
        };
        for (const [batchIndex, batch] of scheduled.entries()) if (await executeStage(batch, batchIndex, enclosingRequest) === false) break;
      }, { instructions, input: payload }, chainTimeout, signal);
      if (signal?.aborted) throw signal.reason;

      state.status = state.retrievalLimited || state.continuationPending ? 'pending' : 'completed';
      if (state.retrievalLimited) {
        const codes = new Set([...(state.retrievalLimits ?? []), ...(state.groupRetrievalLimits ?? [])].map(limit => limit.code));
        state.reason = codes.has('RETRIEVAL_ROUND_BUDGET_EXCEEDED')
          ? '单阶段检索轮数上限达到，未完成完整审查；读取额度可能仍有余量，已有发现保留，不表示通过'
          : (readerAllocation ? '阶段取证分配或共享读取预算受限，未完成完整审查；其他阶段保留额度不表示本阶段已完成，已有发现保留' : '共享读取调用或输出预算受限，未完成完整审查；已有发现保留，不表示通过');
        if (codes.size === 1) state.failureCode = [...codes][0];
      }

    } catch (error) {
      if (error?.code === 'MODEL_ARTIFACT_FAILED') { checkpointFailed = true; checkpointFailure = error; controller.abort(error); throw error; }
      state.status = signal?.aborted ? 'cancelled' : error?.code === 'PROJECT_MODEL_CALL_LIMIT' ? 'pending' : 'failed';
      state.reason = error?.message ?? String(error);
      if(error?.attempts)state.protocolAttempts=error.attempts;
      if(error?.responseAttempts)state.responseAttempts=error.responseAttempts;
      if(error?.diagnostic)state.protocolDiagnostic=error.diagnostic;
      for(const pass of state.reviewPasses??[])if(pass.status==='running')pass.status=signal?.aborted?'cancelled':'failed';
      state.failureCode = signal?.aborted ? 'CANCELLED' : ['MODEL_INVALID_JSON','MODEL_INCOMPLETE_OUTPUT','MODEL_TIMEOUT','MODEL_INVALID_READ_REQUEST','MODEL_OUTPUT_LIMIT','MODEL_PROTOCOL_ERROR','MODEL_INVALID_REVIEW_RESPONSE','MODEL_INVALID_FINDING_IDENTITY','MODEL_INVALID_FINDING_SEVERITY','MODEL_MISSING_FINDING_FIELD','MODEL_INVALID_ANCHOR','MODEL_ANCHOR_MISMATCH','READER_CALL_BUDGET_EXCEEDED','READER_OUTPUT_BUDGET_EXCEEDED','RETRIEVAL_ROUND_BUDGET_EXCEEDED','RETRIEVAL_FINAL_RESPONSE_REQUIRED','PROJECT_MODEL_CALL_LIMIT'].includes(error?.code) ? error.code : 'REVIEW_EXECUTION_FAILED';
    }
    } finally {
      if (readerAllocation && file.eligibility === 'reviewable' && !options.resumeState?.completed?.some(row => row.fileId === file.id)) {
        if (options.enableStageContinuation || ![...groupPrepared.values()].some(group => group.fileIds.includes(file.id))) releaseStage('primary:' + file.id);
        releaseStage('verification:' + file.id);
        releaseStage('synthesis:' + file.id);
        for (const plan of interactionPlans.filter(plan => input.files.filter(member => plan.group.fileIds.includes(member.id)).at(-1)?.id === file.id)) releaseStage('interaction:' + plan.group.id);
      }
      state.resumeEligible = state.status === 'completed' && !state.stageFailures?.length && !state.reviewPasses?.some(pass => pass.status !== 'completed') && !state.windowCoverage?.pending?.length && !state.retrievalLimited && result.findings.every(f => f.verification?.status === 'completed') && report.interactions.filter(item => item.fileIds?.includes(file.id)).every(item => item.status === 'completed');
      await options.onProgress?.({stage:'file-complete',snapshotId:input.id,file:state,findings:result.findings});
      checkpointStages();
      await options.onResumeCheckpoint?.({ ...report, files: fileResults.filter(Boolean).map(item => item.state), findings: fileResults.filter(Boolean).flatMap(item => item.findings), limitations: [...report.limitations, ...fileResults.filter(Boolean).flatMap(item => item.limitations)] });
    }
  };
  if (options.resumeState?.businessGrouping) report.businessGrouping = structuredClone(options.resumeState.businessGrouping);
  for (const interaction of report.interactions) {
    if (interaction.fileIds.every(id => options.resumeState?.completed?.some(row => row.fileId === id))) Object.assign(interaction, { status: 'completed', reused: true });
  }
  // Freeze grouping before admitting file chains, without serializing a whole first file.
  if (options.enableBusinessGrouping === true && prepareBusinessGroups(input.files) && !signal.aborted) {
    try {
      const local = report.businessGrouping?.groups ? report.businessGrouping : localBusinessGroups(input.files);
      const grouped = local ?? await invoke(async request => {
        const groupInput = prepareBusinessGroups(input.files);
        if ((options.nativeOutputTools === true ? !modelWireBudget({ input: groupInput, instructions: BUSINESS_GROUP_INSTRUCTIONS, nativeOutputTools: true }, maxInputBytes).fits : Buffer.byteLength(groupInput) + Buffer.byteLength(BUSINESS_GROUP_INSTRUCTIONS) > maxInputBytes)) throw new Error('Business grouping input budget exceeded');
        reserveShared();
        return validateBusinessGroups(await sharedModel({ ...request, reviewPhase: 'business-grouping', callPurpose: 'business-grouping' }), input.files);
      }, { input: prepareBusinessGroups(input.files), instructions: BUSINESS_GROUP_INSTRUCTIONS }, timeoutMs, signal);
      report.businessGrouping = { status: 'completed', ...grouped };
      for (const group of grouped.groups.filter(g => g.fileIds.length > 1)) {
        if (interactionPlans.some(p => [...p.group.fileIds].sort().join(',') === [...group.fileIds].sort().join(','))) continue;
        const prepared = prepareInteractionInput(input, group, payload => initialInputBudget({ instructions, input: payload, maxRetrievalRounds }, scope, maxInputBytes));
        interactionPlans.push({ group, prepared });
        if (prepared.status !== 'not-applicable') report.interactions.push({ groupId: group.id, fileIds: prepared.fileIds, status: group.fileIds.every(id => options.resumeState?.completed?.some(row => row.fileId === id)) ? 'completed' : prepared.status === 'ready' ? 'pending' : 'blocked', reason: prepared.reason, lifecycle: 'shares-last-primary-timeout' });
      }
    } catch (error) {
      if (signal.aborted || checkpointFailed || error.code === 'MODEL_ARTIFACT_FAILED') throw error;
      report.businessGrouping = { status: 'fallback', reason: error.message };
      report.limitations.push({ text: '业务分组未完成，保留原分组：' + error.message });
    }
  }
  if (options.enableGroupPrimary === true && scope && rounds === 1) {
    const seen = new Set();
    const groups = [...(report.migrationContracts?.groups ?? []), ...(report.businessGrouping?.groups ?? report.grouping?.groups ?? [])];
    for (const group of groups) {
      if (group.fileIds.some(id => seen.has(id) || options.resumeState?.completed?.some(row => row.fileId === id) || options.resumeState?.stageGenerations?.some(row => row.fileId === id))) continue;
      const prepared = prepareGroupPrimary(input, group, { instructions, scope, maxInputBytes, maxRetrievalRounds, focusPrimaryContext: options.focusPrimaryContext === true, enableRiskPlanning: options.enableRiskPlanning === true, enableGroupInteractions: options.enableGroupInteractions === true, migrationContracts: report.migrationContracts?.contracts ?? [] });
      if (!prepared) continue;
      groupPrepared.set(group.id, prepared);
      for (const id of group.fileIds) seen.add(id);
    }
    report.primaryGroups = [...groupPrepared].map(([groupId, p]) => ({ groupId, fileIds: p.fileIds, mode: 'group-primary' }));
  }
  if (scope && (options.optimizeReviewCalls === true || options.enableStageContinuation === true)) {
    const units = [];
    const reusable = new Set((options.resumeState?.completed ?? []).map(row => row.fileId));
    for (const [id, prepared] of groupPrepared) units.push({ id: 'group:' + id, weight: prepared.fileIds.length * 4 });
    for (const file of input.files.filter(file => file.eligibility === 'reviewable' && !reusable.has(file.id))) {
      const prepared = preparePrimaryInput(input, file, { instructions, scope, grouping: report.grouping, maxInputBytes, maxRetrievalRounds, riskPlanningMode: options.riskPlanningMode, focusPrimaryContext: options.focusPrimaryContext === true, enableRiskPlanning: options.enableRiskPlanning, skipSmallRiskPlans: options.skipSmallRiskPlans });
      // Reserve fallback floors before the group starts; released immediately
      // after successful validation, without granting a second root budget.
      if (options.enableStageContinuation || ![...groupPrepared.values()].some(group => group.fileIds.includes(file.id))) units.push({ id: 'primary:' + file.id, weight: 4 * Math.max(1, prepared.batches?.length ?? 1) });
      if (prepared.synthesis?.status === 'ready') units.push({ id: 'synthesis:' + file.id, weight: 2 });
      if (options.enableVerification === true) units.push({ id: 'verification:' + file.id, weight: 2 });
    }
    for (const plan of interactionPlans.filter(plan => plan.prepared.status === 'ready' && !plan.group.fileIds.every(id => reusable.has(id)))) units.push({ id: 'interaction:' + plan.group.id, weight: 2 });
    if (units.length) readerAllocation = createReviewReaderAllocation(scope, units);
  }
  const dependencies = new Map();
  for (const plan of interactionPlans.filter(p => p.prepared.status === 'ready')) {
    const members = input.files.map((file, index) => plan.group.fileIds.includes(file.id) ? index : -1).filter(index => index >= 0);
    const owner = members.at(-1);
    if (owner !== undefined) dependencies.set(owner, [...new Set([...(dependencies.get(owner) ?? []), ...members.slice(0, -1)])]);
  }
  await scheduleFileChains(input.files.map((_, index) => index), async index => {
    try { await runFile(index); }
    catch (error) { controller.abort(error); throw error; }
  }, dependencies, fileConcurrency);
  if (options.enableStageContinuation === true && deferredStages.length && !signal.aborted) {
    const primaryDone = input.files.filter(file => file.eligibility === 'reviewable' && (options.resumeState?.completed?.some(row => row.fileId === file.id) || primaryStageKeys.get(file.id)?.length && primaryStageKeys.get(file.id).every(key => acceptedStages.has(key)))).map(file => file.id);
    const units = deferredStages.map((stage, index) => ({ id: hash(stage.key), kind: stage.phase, fileIds: stage.fileIds, pendingReason: stage.reason,
      dependencies: stage.phase === 'primary'
        ? deferredStages.slice(0, index).filter(other => other.phase === 'primary' && other.fileId === stage.fileId).map(other => hash(other.key))
        : stage.fileIds.flatMap(id => { const pending = deferredStages.filter(other => other.phase === 'primary' && other.fileId === id); return pending.length ? pending.map(other => hash(other.key)) : ['primary:' + id]; }) }));
    const continuationOptions = { rounds, maxInputBytes, enableMigrationContracts: options.enableMigrationContracts === true, enableMigrationRegression: options.enableMigrationRegression === true };
    let continuation = createStageContinuation(input, continuationOptions, { completedPrimary: primaryDone, units, maxAttempts: 2 });
    if (options.resumeState?.continuation?.state) {
      const fresh = continuation.checkpoint(), prior = options.resumeState.continuation.state;
      for (const unit of fresh.units) { const old = prior.units.find(item => item.id === unit.id && item.kind === unit.kind && JSON.stringify(item.fileIds) === JSON.stringify(unit.fileIds)); if (old && old.status !== 'completed') { unit.attempts = Math.min(fresh.maxAttempts, old.attempts); unit.stopped = unit.attempts >= fresh.maxAttempts; unit.pendingReason = unit.stopped ? 'STAGE_ATTEMPTS_EXHAUSTED' : 'STAGE_INTERRUPTED'; } }
      continuation = createStageContinuation(input, continuationOptions, { completedPrimary: primaryDone, units, checkpoint: fresh, maxAttempts: 2 });
    }
    for (let pass = 0; pass < 2; pass++) {
      let progressed = false;
      for (const stage of [...deferredStages].sort((a, b) => (a.phase === 'primary' ? 0 : a.phase === 'verification' ? 1 : 2) - (b.phase === 'primary' ? 0 : b.phase === 'verification' ? 1 : 2))) {
        if (stage.done || !continuation.ready().some(unit => unit.id === hash(stage.key))) continue;
        if (performance.now() >= fileDeadlines.get(stage.fileId) || signal.aborted || report.modelCalls >= maxCalls || options.remainingCalls?.() <= 0) {
          stage.reason = signal.aborted ? 'STAGE_CANCELLED' : performance.now() >= fileDeadlines.get(stage.fileId) ? 'STAGE_TIMEOUT' : 'PROJECT_MODEL_CALL_LIMIT';
          continuation.stop(hash(stage.key), stage.reason); continue;
        }
        const eligibleIds = [...new Set(deferredStages.filter(candidate => !candidate.done && continuation.ready().some(unit => unit.id === hash(candidate.key))).map(candidate => candidate.allocationId))];
        const admitted = !yieldedUnits.has(stage.allocationId) ? { resumed: true } : stage.requests.length ? readerAllocation.resume(stage.allocationId, stage.requests, { eligibleIds }) : readerAllocation.resumeBudget(stage.allocationId, { eligibleIds });
        if (!admitted.resumed) { stage.reason = ['READER_CALL_BUDGET_EXCEEDED', 'READER_OUTPUT_BUDGET_EXCEEDED'].includes(admitted.reason) ? admitted.reason : 'STAGE_ALLOCATION_WAITING'; continue; }
        yieldedUnits.delete(stage.allocationId);
        if (!stage.allocationId.startsWith('verification:') || !deferredStages.some(other => other !== stage && !other.done && other.fileId === stage.fileId)) queuedStageUnits.delete(stage.allocationId);
        const token = continuation.start(hash(stage.key), { signal });
        stage.attempts++; await stage.run();
        progressed = true;
        if (stage.succeeded && !yieldedUnits.has(stage.allocationId)) { stage.done = true; continuation.complete(hash(stage.key), token.attempt, { signal }); if (!deferredStages.some(other => other !== stage && !other.done && other.allocationId === stage.allocationId) && !queuedStageUnits.has(stage.allocationId)) readerAllocation?.release(stage.allocationId); }
        else { const cause = stage.reason === 'STAGE_DEPENDENCY_PENDING' ? 'STAGE_FAILED' : stage.reason ?? 'STAGE_FAILED'; continuation.yield(hash(stage.key), cause); if (!yieldedUnits.has(stage.allocationId)) continuation.stop(hash(stage.key), cause); }
        if (!deferredStages.some(other => !other.done && other.fileId === stage.fileId)) {
          queuedStageUnits.delete('verification:' + stage.fileId);
          releaseStage('verification:' + stage.fileId);
        }
      }
      if (!progressed) break;
    }
    // File completion is derived from accepted generations, not a stale pre-retry baseline.
    for (const [id, keys] of primaryStageKeys) if (!primaryDone.includes(id) && keys.length && keys.every(key => acceptedStages.has(key))) primaryDone.push(id);
    report.stageContinuation = continuation.summary();
    report.continuation = continuation.checkpoint();
    for (const unit of report.continuation.units) if (unit.status !== 'completed') {
      const stage = deferredStages.find(item => hash(item.key) === unit.id);
      if (stage?.reason && !unit.stopped) unit.pendingReason = stage.reason;
    }
    report.continuationOptions = continuationOptions;
    for (const file of input.files) {
      const result = fileResults[input.files.indexOf(file)];
      const pending = deferredStages.filter(stage => stage.fileId === file.id && !stage.done);
      if (result?.state.continuationPending && !pending.length) { result.state.continuationPending = false; if (result.state.status === 'pending' && primaryDone.includes(file.id) && !result.state.stageFailures?.length && !result.state.reviewPasses?.some(pass => pass.status !== 'completed')) result.state.status = result.state.retrievalLimited ? 'pending' : 'completed'; }
    }
    checkpointStages();
    await options.onResumeCheckpoint?.({ ...report, files: fileResults.map(result => result.state), findings: fileResults.flatMap(result => result.findings), limitations: [...report.limitations, ...fileResults.flatMap(result => result.limitations)] });
  }
  for (const id of new Set([...yieldedUnits, ...queuedStageUnits])) readerAllocation?.release(id);
  if (checkpointFailed) throw checkpointFailure;
  for (const result of fileResults) if (result?.state.continuationPending === false) { const state = result.state; state.resumeEligible = state.status === 'completed' && !state.stageFailures?.length && !state.reviewPasses?.some(pass => pass.status !== 'completed') && !state.windowCoverage?.pending?.length && !state.retrievalLimited && result.findings.every(finding => finding.verification?.status === 'completed') && report.interactions.filter(item => item.fileIds?.includes(state.fileId)).every(item => item.status === 'completed'); }
  report.files = fileResults.map(result => result.state);
  // Derive only from host-prepared state, including reused checkpoint state. Never
  // reclassify model or historical limitations by text or model-supplied tags.
  report.scopeNotices = report.files.filter(file => file.contextMode === 'approved-retrieval').map(file => ({ fileId: file.fileId, text: '初始输入仅提供聚焦上下文或身份目录，其他批准全文须按需读取；不声明所有上下文已核查。' }));
  report.findings = fileResults.flatMap(result => result.findings);
  report.limitations.push(...fileResults.flatMap(result => result.limitations));
  report.execution = { fileConcurrency, maxRetrievalRounds };
  report.readerLimits = { maxRounds: maxRetrievalRounds, maxVerificationRounds: maxVerificationRetrievalRounds };
  await options.onProgress?.({stage:'batch-complete',snapshotId:input.id,files:report.files,findings:report.findings,limitations:report.limitations});
  for (const interaction of report.interactions) if (interaction.status !== 'completed') report.limitations.push({ text: '跨文件综合未完成：' + interaction.groupId + ' (' + interaction.status + ')' });
  if (report.grouping?.links.some(l => l.split)) report.limitations.push({ text: '跨组关系未综合覆盖；关联分组不代表全部跨文件交互覆盖' });
  const reviewableCount = input.files.filter(f => f.eligibility === 'reviewable').length;
  report.selection = { total: input.files.length, reviewable: reviewableCount, excluded: input.files.filter(f => f.eligibility === 'excluded').length, blocked: input.files.filter(f => f.eligibility === 'blocked').length };
  if (!reviewableCount) report.limitations.push({ text: input.files.length ? '没有可审查文件；排除或阻塞不表示代码审核通过。' : '未选择变更文件，没有执行代码审核。' });
  const unfinished = report.files.some(f => !['completed', 'excluded'].includes(f.status));
  report.status = signal?.aborted ? 'cancelled' : unfinished || report.limitations.length || report.stageContinuation?.pending || report.files.some(file => file.synthesisStatus && file.synthesisStatus !== 'completed') ? 'partial' : 'completed';
  if (report.files.some(f => f.status === 'failed') && !report.files.some(f => f.status === 'completed')) report.status = signal?.aborted ? 'cancelled' : 'failed';
  report.coverage = Object.fromEntries(['completed', 'excluded', 'blocked', 'failed', 'cancelled', 'pending'].map(s => [s, report.files.filter(f => f.status === s).length]));
  if (scope) {
    report.retrievalUsage = scope.usage();
    report.retrievalSources = scope.catalog();
  }
  report.regressionCoverage = Object.fromEntries(['introduced', 'preexisting', 'uncertain', 'unassessed'].map(classification => [classification, report.findings.filter(f => (f.verification?.regression?.classification ?? 'unassessed') === classification).length]));
  report.findingGroups = groupDuplicateFindings(report.findings);
  for (const state of report.files) state.resumeEligible = state.status === 'completed' && !state.continuationPending && (!state.synthesisStatus || state.synthesisStatus === 'completed') && !state.stageFailures?.length && !state.reviewPasses?.some(pass => pass.status !== 'completed') && !state.windowCoverage?.pending?.length && !state.retrievalLimited && report.findings.filter(f => f.fileId === state.fileId).every(f => f.verification?.status === 'completed') && report.interactions.filter(item => item.fileIds?.includes(state.fileId)).every(item => item.status === 'completed');
  await options.onResumeCheckpoint?.(report);
  report.followup = coverageFollowup(report);
  if (scope) report.readerBudget = { ...scope.usage(), ...scope.budget(), ...readerLimits };
  if (readerAllocation) report.readerAllocation = readerAllocation.summary();
  report.diagnostics = reviewDiagnostics(report, { reviewWallMs: performance.now() - startedAt });
  return report;
}
const safe = text => Array.from(String(text ?? '')).map(c => {
  if (c.charCodeAt(0) < 32) return ' ';
  if (c === '&') return '&amp;';
  if (c === '<') return '&lt;';
  if (c === '>') return '&gt;';
  if ('*_[]#|!()\\'.includes(c) || c.charCodeAt(0) === 96) return '\\' + c;
  return c;
}).join('');
function renderFinding(output, finding, index, duplicates) {
    const a = finding.anchor;
    const location = a.kind === 'line' ? a.side + ':' + a.start + '-' + a.end : a.kind === 'property' ? '属性 ' + a.name : '文件级';
    output.push('', '### [' + finding.severity + '] ' + safe(finding.title), safe(finding.path) + ' · ' + safe(location));
    if (finding.interaction) output.push('- 跨文件编辑引用：' + safe(finding.interaction.editRefs.map(r => r.fileId + ':' + r.editId).join(', ')) + '；引用及读取已校验，因果未经证实');
    const regression = finding.verification?.regression;
    const regressionLabel = ({ introduced: '模型判断本次引入', preexisting: '模型判断原有问题', uncertain: '前后对照证据不足', unassessed: '尚未评估修改前后' }[regression?.classification ?? 'unassessed']);
    output.push(finding.attribution?.causality==='current-source-only'?'- 审查模式：当前源码缺陷检查，不评估历史回归归因。':'- 回归分类：' + regressionLabel + '；不等于因果事实证明');
    if (regression?.reason) output.push('- 前后对照理由：' + safe(regression.reason));
    if (regression?.oldEvidence) output.push('- 前后对照证据索引（本候选复核证据零基）：old=' + regression.oldEvidence.join(',') + '；new=' + regression.newEvidence.join(','));
    if (duplicates.has(index)) {
      output.push('- 重复报告候选：与第 ' + (duplicates.get(index) + 1) + ' 条共享完整已校验证据及解释；不证明根因成立。原始候选保留于JSON。');
      output.push('- 本处变更引用：' + safe([...finding.attribution.editIds, ...finding.attribution.properties].join(', ')));
      output.push('- 本处定位原文：' + safe(a.snippet ?? '文件或属性定位'));
      output.push('- 复核状态：模型复核支持；完整证据同前述发现，不是事实或因果证明');
      return;
    }
    const verification = finding.verification;
    if (verification) {
      const label = verification.status !== 'completed' ? '未完成' : ({ supported: '模型复核支持', refuted: '模型复核反驳（保留候选供追溯）', uncertain: '不确定' }[verification.verdict] ?? '未知');
      output.push('- 复核状态：' + label + (finding.reused ? '（相同快照的既往轮次结果，本次未重新取证）' : '') + '；不是事实或因果证明');
      if (verification.reason) output.push('- 复核理由：' + safe(verification.reason));
      for (const ref of verification.evidence ?? []) output.push('- 复核证据：' + safe(ref.sourceId) + ':' + ref.start + '（' + ref.count + '行） · SHA256 ' + safe(ref.hash) + ' · ' + safe(ref.text));
    }
    const attribution = finding.attribution;
    output.push('- 归因状态：' + (attribution?.causality==='current-source-only'?'当前源码模式，不适用变更归因':attribution?.status === 'references-validated' ? '变更引用已校验；因果解释未经独立验证' : '缺少变更归因'));
    if (attribution?.status === 'references-validated') {
      output.push('- 变更引用：' + safe([...attribution.editIds, ...attribution.properties].join(', ')));
      for (const [key, label] of [['beforeBehavior', '修改前'], ['afterBehavior', '修改后'], ['reason', '因果解释']]) output.push('- ' + label + '：' + safe(attribution[key]));
    }
    for (const [key, label] of [['trigger','触发条件'],['evidence','证据'],['impact','影响'],['suggestion','建议']]) output.push('- ' + label + '：' + safe(finding[key]));
  }

export function markdownReport(report) {
  const output = ['# Code Review 报告', ...reportSummaryMarkdown(report), ...findingsMarkdown(report), ...readabilityMarkdown(report), '', '## 技术附录', '', '<details>', '<summary>展开完整证据、逐项覆盖与执行诊断（不影响上面的结论）</summary>', '', '状态：' + safe(report.status), '快照：' + safe(report.snapshotId), '', '## 候选原始证据与判定'];
  if (!report.findings.length) output.push(report.status === 'completed' ? '在已审查范围内未发现具体问题；不代表代码已被证明正确。' : '当前没有有效问题记录，但审查存在未完成项或限制，不能视为通过。');
  const duplicates = new Map();
  for (const group of groupDuplicateFindings(report.findings)) for (const index of group.findingIndices.slice(1)) duplicates.set(index, group.findingIndices[0]);
  for (const [index, finding] of report.findings.entries()) renderFinding(output, finding, index, duplicates);
  output.push('', '## 覆盖情况');
  if (report.callerDiscovery) output.push('- 引用方发现：扫描 '+report.callerDiscovery.scanned.length+' 个文件，捕获 '+report.callerDiscovery.capturedPaths.length+' 个上下文；仅批准目录字面引用导航，不证明函数调用或完整覆盖。');
  if(report.businessRequirement)output.push('- 业务需求：SHA256 '+safe(report.businessRequirement.hash)+' · '+report.businessRequirement.bytes+' bytes；不可信约束，不是证据或权限，全文不在报告重复。');
  for (const file of report.files) for (const correction of file.anchorCorrections ?? []) output.push('- 定位纠正：' + safe(correction.originalCandidate.fileId) + ' · ' + safe(correction.status) + ' · ' + safe(correction.reason) + '；原完整候选保留JSON，仅定位不证明因果');
  if (report.history) output.push('- ' + (String(report.history.mode).startsWith('svn') ? 'SVN' : 'Git') + '历史审查：' + safe(report.history.mode) + ' · ' + safe(report.history.base ?? 'empty') + ' → ' + safe(report.history.target) + '；精确端点树差异，重命名按增删，不含工作树');
  if (report.changeScope) output.push('- Git审查范围：' + safe(changeScopeLabel(report.changeScope)) + '；其他范围未审查，未跟踪文件仍默认排除。');
  if (report.businessGrouping) output.push('- 业务分组：' + safe(report.businessGrouping.status) + (report.businessGrouping.reason ? ' — ' + safe(report.businessGrouping.reason) : '') + '；仅调度假设，不证明依赖或覆盖');
  for (const file of report.files) for (const plan of file.riskPlans ?? []) output.push('- 风险计划：' + safe(file.path) + ' · ' + safe(plan.status) + (plan.method === 'inline' ? '（合并主审，非独立规划）' : '') + ' · ' + plan.risks.length + '项待证假设；不表示缺陷成立或覆盖完成');
  for (const file of report.files) if(file.reviewPasses)output.push('- 独立审查轮次 '+safe(file.path)+'：'+file.reviewPasses.filter(p=>p.status==='completed').length+'/'+file.reviewPasses.length+'阶段完成；同一生命周期预算，后续轮无首轮计划；不证明代码正确。');
  for(const file of report.files)for(const failure of file.stageFailures??[])output.push('- 未完成阶段：'+safe(file.path)+' · '+safe(failure.phase)+' · '+safe(failure.code)+'；主审成果保留。');
  for (const file of report.files) output.push('- ' + safe(file.path) + '：' + file.status + (file.reason ? ' — ' + safe(file.reason) : ''));
  if (report.grouping) {
    const names = new Map(report.files.map(f => [f.fileId, f.path]));
    output.push('', '## 关联上下文', '关联仅为命名提示，不证明依赖或缺陷；每个主文件独立审查。');
    for (const link of report.grouping.links) output.push('- ' + safe(names.get(link.from)) + ' ↔ ' + safe(names.get(link.to)) + '：' + safe(link.reasons.join(', ')) + (link.split ? '（受组上限限制，已拆组）' : ''));
    for (const file of report.files) if (file.relatedFileIds?.length) output.push('- ' + safe(file.path) + '：输入包含 ' + file.relatedFileIds.length + ' 个关联文件');
  }
  for (const file of report.files) if (file.windowCoverage) output.push('- ' + safe(file.path) + '：变更窗口已完成 ' + file.windowCoverage.completed.length + '，待审 ' + file.windowCoverage.pending.length + '；仅表示窗口分析完成，不证明全文正确');
  for (const file of report.files) if (file.synthesisStatus) output.push('- ' + safe(file.path) + '：跨窗口综合 ' + safe(file.synthesisStatus) + '；不等于事实正确性证明');
  for (const interaction of report.interactions ?? []) output.push('- 跨文件综合 ' + safe(interaction.groupId) + '：' + safe(interaction.status) + (interaction.failureCode ? ' · ' + safe(interaction.failureCode) : '') + (interaction.reason ? ' — ' + safe(interaction.reason) : '') + '；与组末主文件共享生命周期，不证明完整交互覆盖');
  if (report.rules?.length) output.push('', '## 项目规则', '规则仅为已批准约束数据，不扩大权限或证明缺陷。', ...report.rules.map(rule => '- ' + safe(rule.path) + ' · SHA256 ' + safe(rule.hash)));
  if (report.followup?.suggestedPaths.length) output.push('', '## 后续选择建议', '仅为原快照未完成项；不会自动续审。再次执行需新预览、新审批，并显式选择规则和上下文。阻断项需先处理原因；关联上下文不等于主文件已审查。', ...report.followup.items.filter(item => item.followup).map(item => '- ' + safe(item.path) + '：' + item.status + (item.incompleteVerification ? '（候选复核未完成）' : '')));
  output.push(...diagnosticsMarkdown(report.diagnostics));
  output.push(...limitationDetailsMarkdown(report), '', '</details>');
  return output.join('\n') + '\n';
}
