import { buildMigrationRouteHints } from './migration-route-hints.mjs';
import { buildMigrationContracts } from './migration-contracts.mjs';
import { splitWholeBatch } from './whole-batch-split.mjs';
import { splitUnsentChildBatch } from './child-capacity-error.mjs';
import { REVIEW_INSTRUCTIONS } from './prompts.mjs';
import { runWholeScopeWorkers, createCheckpointQueue } from './whole-scope-workers.mjs';
import { changesConcurrency } from './review-execution-policy.mjs';
import { createReviewReader } from './review.mjs';
import { prepareWholeScope } from './whole-scope-plan.mjs';
import { retrievalLoop } from './retrieval-loop.mjs';
import { verificationLoop } from './verification-loop.mjs';
import { runCounterVerification } from './counter-verification.mjs';
import { validateGroupPrimary, validateGroupPrimaryMembers } from './group-primary.mjs';
import { modelWireBudget, configureWireBudget } from './model-wire-budget.mjs';
import { createReviewReaderAllocation } from './review-reader-allocation.mjs';
import { retrievalRounds, verificationRetrievalRounds } from './review-execution-policy.mjs';
import { validateBusinessRequirement } from './business-requirement.mjs';

import { createWholeVerificationQueue } from './whole-verification-queue.mjs';

const failure = (code, message) => Object.assign(new Error(message), { code });
const isBudget = error => ['WHOLE_SCOPE_MODEL_CALL_LIMIT', 'PROJECT_MODEL_CALL_LIMIT'].includes(error?.code);

// Only the caller can authorize the snapshot and supply the ordinary finding
// validator. This executor never reads the filesystem or relaxes attribution.
export async function reviewWholeScope(snapshot, model, options = {}) {
  const { maxInputBytes = 96 * 1024, maxCalls = Number.MAX_SAFE_INTEGER, timeoutMs = 0 } = options;
  if ((options.reviewRounds ?? 1) !== 1 || options.resumeState) throw new Error('Whole-scope requires fresh single-round changes review');
  if (typeof model !== 'function' || typeof options.validateFindingResponse !== 'function') throw new Error('Whole-scope review requires model and validateFindingResponse');
  for (const value of [maxInputBytes, maxCalls]) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid whole-scope limit');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new Error('Invalid whole-scope timeout');
  if (options.enableModelComparison !== undefined && typeof options.enableModelComparison !== 'boolean') throw new Error('Invalid model comparison policy');
  if (options.enableAnchorCorrection !== undefined && typeof options.enableAnchorCorrection !== 'boolean') throw new Error('Invalid anchor correction option');
  for (const key of ['enableAsyncVerification', 'enableMemberIsolation', 'enableInvestigationState', 'relationAwareGrouping']) if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new Error('Invalid ' + key);
  const asyncVerification = options.enableAsyncVerification === true;
  const verificationConcurrency = options.verificationConcurrency ?? 2;
  if (!Number.isInteger(verificationConcurrency) || verificationConcurrency < 1 || verificationConcurrency > 4) throw new Error('Invalid verificationConcurrency');
  const maxRounds = retrievalRounds(options.maxRetrievalRounds);
  const maxVerificationRounds = verificationRetrievalRounds(options.maxVerificationRetrievalRounds, maxRounds);
  const concurrency = changesConcurrency(options.wholeScopeConcurrency ?? 2);
  if (options.createBatchModel !== undefined && typeof options.createBatchModel !== 'function') throw new Error('Invalid child agent factory');
  const input = structuredClone(snapshot);
  if (!input || !['git', 'svn'].includes(input.vcs) || !Array.isArray(input.files) || input.files.length > 200 || input.projectScope || input.files.some(file => file.reviewMode === 'project')) throw new Error('Whole-scope review requires a changes snapshot');
  const identities = new Set(), paths = new Set();
  for (const file of input.files) {
    if (!file || typeof file.id !== 'string' || !file.id || identities.has(file.id) || typeof file.path !== 'string' || !file.path || paths.has(file.path) || !['reviewable', 'excluded', 'blocked'].includes(file.eligibility)) throw new Error('Invalid or duplicate snapshot file');
    identities.add(file.id); paths.add(file.path);
    if (file.eligibility === 'reviewable' && (typeof file.left?.text !== 'string' || typeof file.right?.text !== 'string' || !Array.isArray(file.properties))) throw new Error('Missing review content');
  }
  input.context ??= [];
  validateBusinessRequirement(input.businessRequirement);
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(failure('MODEL_TIMEOUT', 'Model timeout')), timeoutMs) : undefined;
  const report = {
    schemaVersion: 1, snapshotId: input.id, vcs: input.vcs, status: 'completed',
    files: [], findings: [], limitations: [], modelCalls: 0, startedAt: new Date().toISOString(),
    orchestration: { strategy: 'whole-scope', wholeScope: true, maxRetrievalRounds: maxRounds, maxVerificationRetrievalRounds: maxVerificationRounds, modelMetrics: {}, modelCallPurposes: {}, batches: [] },
    interactions: [], rules: (input.rules ?? []).map(({ path, hash }) => ({ path, hash })),
  };
  const protocolTelemetry={scope:'all-child-tool-generations',complete:false,invalidRequests:0,directInvalidRequests:0,childInvalidRequests:0};
  let telemetryCovered=true;
  const recordProtocolEvent=async event=>{if(event?.action==='retrieval-protocol-unobserved')telemetryCovered=false;if(event?.action==='retrieval-protocol-invalid'&&['RETRIEVAL_INVALID_SCHEMA','RETRIEVAL_UNAUTHORIZED_SOURCE','RETRIEVAL_INVALID_RANGE'].includes(event.code)){protocolTelemetry.invalidRequests++;protocolTelemetry.directInvalidRequests++;}await options.onProtocolEvent?.(event);};
  const publishProtocolTelemetry=complete=>{report.diagnostics??={};report.diagnostics.retrievalProtocolTelemetry={...protocolTelemetry,complete:complete&&telemetryCovered};};
  const stateById = new Map();
  let reader, readerAllocation, verificationQueue, asyncAllocation, checkpointFailed = false, fatalError;
  const allocateReaders = asyncVerification || options.optimizeReviewCalls === true || options.enableStageContinuation === true;
  const wireScope = scope => configureWireBudget(scope, { nativeOutputTools: options.nativeOutputTools === true });
  const checkpoints = createCheckpointQueue(options.onResumeCheckpoint, error => { checkpointFailed = true; fatalError ??= error; controller.abort(error); });
  const reportOrder = new Map(input.files.map((file, index) => [file.id, index]));
  const checkpoint = () => {
    report.findings.sort((a, b) => reportOrder.get(a.fileId) - reportOrder.get(b.fileId) || JSON.stringify(a.anchor).localeCompare(JSON.stringify(b.anchor)) || a.title.localeCompare(b.title));
    return checkpoints.enqueue(report);
  };
  const gate = () => {
    signal.throwIfAborted();
    if (report.modelCalls >= maxCalls) throw failure('WHOLE_SCOPE_MODEL_CALL_LIMIT', 'Model call budget exceeded');
    if (options.remainingCalls?.() <= 0) throw failure('PROJECT_MODEL_CALL_LIMIT', 'Shared project model call limit exceeded');
  };
  // Bounded metadata only: never retain request payload, response, or source text.
  const shape = report.orchestration.executionShape = { modelRequests: [], totalModelRequests: 0, omittedModelRequests: 0, limit: 4096 };
  const attempts = new Map();
  const requestRecord = (phase, unitId, observedStart = true) => {
    const key = phase + ':' + unitId, attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    const row = { phase, unitId, attempt, startedAt: observedStart ? new Date().toISOString() : null, durationMs: null, inputBytes: null, totalOutputBytes: null, status: 'pending', metricsObserved: false };
    shape.totalModelRequests++;
    if (shape.modelRequests.length < shape.limit) shape.modelRequests.push(row); else shape.omittedModelRequests++;
    return row;
  };
  const trackModel = (delegate, unitId) => async request => {
    gate();
    if (!modelWireBudget(request, maxInputBytes).fits) throw failure('WHOLE_SCOPE_INPUT_BUDGET', 'Actual model wire input budget exceeded');
    report.modelCalls++;
    const timing = requestRecord(request.reviewPhase, unitId ?? request.reviewUnitId ?? 'whole');
    const started = performance.now();
    let eventTiming = timing;
    try {
    const result = await delegate({ ...request, maxInputBytes,
      onModelArtifact: options.onModelArtifact ? async artifact => {
        try {
          const reference = await options.onModelArtifact({ ...artifact, snapshotId: input.id, phase: request.reviewPhase });
          if (reference) (report.artifacts ??= []).push(reference);
        } catch (error) {
          throw failure('MODEL_ARTIFACT_FAILED', error?.message ?? 'Model artifact persistence failed');
        }
      } : undefined,
      onProtocolCorrection: async info => {
        gate(); report.modelCalls++;
        const correction = requestRecord(request.reviewPhase, unitId ?? request.reviewUnitId ?? 'whole', false); correction.status = 'correction-admitted-unobserved'; eventTiming = correction;
        (report.orchestration.modelCorrections ??= []).push(info);
        await options.onProtocolCorrection?.(info);
      },
      onModelEvent: async info => {
        if (info.action === 'model-start') { eventTiming.startedAt = new Date().toISOString(); eventTiming.status = 'running'; }
        if (info.action === 'model-end') {
          eventTiming.metricsObserved = true; eventTiming.status = 'settled';
          for (const key of ['durationMs', 'inputBytes', 'totalOutputBytes']) eventTiming[key] = Number.isFinite(info[key]) ? info[key] : null;
          const metrics = report.orchestration.modelMetrics[request.reviewPhase] ??= { calls: 0, durationMs: 0, inputBytes: 0, totalOutputBytes: 0 };
          metrics.calls++;
          for (const key of ['durationMs', 'inputBytes', 'totalOutputBytes']) metrics[key] = Number.isFinite(info[key]) ? (metrics[key] ?? 0) + info[key] : null;
          if (info.callPurpose) report.orchestration.modelCallPurposes[info.callPurpose] = (report.orchestration.modelCallPurposes[info.callPurpose] ?? 0) + 1;
        }
        await options.onModelEvent?.(info);
        await options.onProgress?.({ stage: info.action, snapshotId: input.id, phase: request.reviewPhase, ...info });
      },
    });
    signal.throwIfAborted();
    timing.status = 'completed';
    return result;
    } catch (error) { timing.status = signal.aborted ? 'cancelled' : 'failed'; throw error; }
    finally { timing.wrapperDurationMs = Math.max(0, performance.now() - started); }
  };
  const trackedModel = trackModel(model);
  const requestFor = batch => ({ input: batch.payload, instructions: batch.instructions, signal,
    reviewPhase: 'group-primary', reviewUnitId: batch.id, nativeOutputTools: options.nativeOutputTools === true,
    onProtocolEvent: recordProtocolEvent });
  const loopOptions = stage => ({ maxRounds, maxInputBytes, beforeCall: gate, correctProtocol: options.correctProtocol === true,
    onRetrieved: records => { (stage.retrievalAudit ??= []).push(...records); },
    onTruncated: () => { report.limitations.push({ text: '批准检索结果截断，不代表全部证据已核查。' }); },
    onBudgetLimited: info => {
      stage.retrievalLimited = true; (stage.retrievalLimits ??= []).push(info);
      report.limitations.push({ text: '阶段取证受限：' + info.code });
    },
  });
  try {
    signal.throwIfAborted();
    reader = createReviewReader(input, { ...options, signal });
    if (options.enableMigrationContracts === true || options.enableMigrationRegression === true) report.migrationContracts = buildMigrationContracts(input);
    if(report.migrationContracts)report.migrationRouteNavigation=buildMigrationRouteHints(input);
    const migrationOptions = { enableModelComparison: options.enableModelComparison === true, enableMigrationRegression: options.enableMigrationRegression === true, migrationContracts: report.migrationContracts?.contracts ?? [], migrationSnapshot: input };
    const plan = prepareWholeScope(input, { enableMigrationContracts: options.enableMigrationContracts, enableMigrationRegression: options.enableMigrationRegression, instructions: options.instructions ?? REVIEW_INSTRUCTIONS, scope: reader, relationAwareGrouping: options.relationAwareGrouping, primaryInputMode: options.primaryInputMode, maxInputBytes, maxRetrievalRounds:maxRounds, childTransport:options.childTransport===true });
    for (const file of input.files) {
      const state = { fileId: file.id, path: file.path, status: file.eligibility === 'reviewable' ? 'pending' : file.eligibility, primaryMethod: 'whole-scope', ...(file.reason ? { reason: file.reason } : {}) };
      stateById.set(file.id, state); report.files.push(state);
    }
    for (const item of plan.oversized) {
      Object.assign(stateById.get(item.fileId), { status: 'blocked', blockCode: 'WHOLE_SCOPE_INPUT_BUDGET', requiredBytes: item.requiredBytes, reason: '完整文件超过单次输入预算，不拆窗口或省略正文。' });
      report.limitations.push({ fileId: item.fileId, text: '完整文件输入超限，未执行主审。' });
    }
    for (const key of ['changeScope', 'history', 'workingScope', 'mergeSources', 'effectiveMergeSources', 'callerDiscovery', 'autoContext']) if (input[key] !== undefined) report[key] = structuredClone(input[key]);
    if (input.callerDiscovery) report.limitations.push({ text: '调用者发现仅限批准来源，不证明真实调用或完整覆盖。' });
    if (input.autoContext?.truncated || input.autoContext?.candidates?.some(item => item.status === 'blocked')) report.limitations.push({ text: '自动上下文存在截断或阻塞，仅实际捕获内容可用于证据。' });
    if (plan.batches.length > 1) report.limitations.push({ text: '整体范围按字节分为多个批次；跨 batch 边界关系未核查，不声明整体范围完整覆盖。' });
    report.scopeNotices = [{ text: options.primaryInputMode === 'focused' ? '聚焦主审只初送当前 batch 完整编辑及原坐标源码范围；未送全文和批准关联源须按需检索，不声明完整全文覆盖。' : '整体主审结合当前 batch 完整文件；批准关联源须按需检索，不声明专门 interaction 阶段或全部上下文覆盖。' }];
    // One primary pool includes all parallel and capacity-split descendants. Never
    // release a live parent's allocation to fund a fresh descendant or peer.
    if (allocateReaders && plan.batches.length) readerAllocation = createReviewReaderAllocation(reader, [
      { id: 'primary', weight: 4 }, { id: 'verification', weight: 2 },
    ]);
    const primaryReader = readerAllocation ? wireScope(readerAllocation.scope('primary')) : reader;
    const parallelChildren = plan.batches.length > 1 && typeof options.createBatchModel === 'function';
    if(parallelChildren)report.orchestration.retrievalProtocol={observed:false,invalidRequests:0,scope:'host-child-snapshot-request-parser'};
    report.orchestration.batchExecution = parallelChildren ? (options.childExecution ?? 'child-factory') : 'direct';
    report.orchestration.batchConcurrency = parallelChildren ? Math.min(concurrency, plan.batches.length) : 1;
    const rejectedMemberIds = new Set();
    const verificationSources = [], findingByIdentity = new Map(), capacityStages = new WeakSet();
    const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
    if (plan.grouping) report.orchestration.grouping = structuredClone(plan.grouping);
    report.orchestration.asyncVerification = { enabled: asyncVerification, concurrency: asyncVerification ? verificationConcurrency : 1, fairness: asyncVerification ? 'fixed-file-floors' : null };
    report.orchestration.batches = plan.batches.map(batch => ({ id: batch.id, fileIds: [...batch.fileIds], status: 'pending' }));
    shape.logicalGroups = (plan.grouping?.groups ?? []).slice(0, 200).map(group => ({ id: group.id, fileIds: group.fileIds, batchIds: group.batchIds }));
    shape.batches = report.orchestration.batches;
    const verifyCandidates = async ({ candidates, targets, batch, stage, candidateReader, release }) => {
      try {
        gate(); // Do not prefetch receipt evidence for a vetoed model call.
        let verdicts = await verificationLoop(trackedModel, { ...requestFor(batch), reviewPhase: 'verification', reviewUnitId: stage.id }, candidates, candidateReader, { ...loopOptions(stage), enableInvestigationState: false, ...migrationOptions, reserveFinalEvidence: allocateReaders, maxRounds: maxVerificationRounds });
        signal.throwIfAborted();
        verdicts = await runCounterVerification(trackedModel, { ...requestFor(batch),reviewPhase:'verification',reviewUnitId:stage.id }, candidates, verdicts, candidateReader, { ...loopOptions(stage),enableInvestigationState:false,...migrationOptions,reserveFinalEvidence:allocateReaders,maxRounds:maxVerificationRounds,enabled:options.enableCounterVerification===true,isFatalError:error=>checkpointFailed||error?.code==='MODEL_ARTIFACT_FAILED' });
        signal.throwIfAborted();
        targets.forEach((finding, i) => { finding.verification = { status: verdicts[i].counterVerification?.status === 'incomplete' ? 'incomplete' : 'completed', ...verdicts[i] }; });
        stage.status = stage.retrievalLimited || verdicts.some(v => v.counterVerification?.status === 'incomplete') ? 'pending' : 'completed';
        if (verdicts.some(v => v.verdict === 'uncertain' || v.verdict === 'supported' && !['introduced', 'preexisting'].includes(v.regression?.classification))) report.limitations.push({ text: '部分候选缺少充分复核证据或前后对照，保留不确定，不强行确认支持或本次引入。' });
      } catch (error) {
        signal.throwIfAborted();
        if (checkpointFailed || error.code === 'MODEL_ARTIFACT_FAILED') { fatalError ??= error; controller.abort(error); throw error; }
        stage.status = 'failed'; stage.failureCode = error.code ?? 'WHOLE_SCOPE_VERIFICATION_FAILED'; stage.reason = error.message;
        if(error.code==='INVALID_MODEL_COMPARISON'&&['structural-schema','evidence-identity','role-side','role-completeness','anchor-edit','context-token'].includes(error.comparisonFailure))stage.comparisonFailure=error.comparisonFailure;
        if(error.code==='INVALID_VERIFICATION_EVIDENCE_SET'&&['not-array','too-many','required-evidence-missing'].includes(error.evidenceFailure)){stage.evidenceFailure=error.evidenceFailure;if(Number.isSafeInteger(error.evidenceCount)&&error.evidenceCount>=0)stage.evidenceCount=error.evidenceCount;}
        if(error.code==='INVALID_EVIDENCE_RECEIPT'&&['mixed-fields','invalid-id-type','unknown-in-current-verification'].includes(error.receiptFailure))stage.receiptFailure=error.receiptFailure;
        targets.forEach(finding => { finding.verification = { status: 'incomplete', causality: 'unverified' }; });
        report.limitations.push({ text: '候选批量复核未完成：' + error.message });
      } finally {
        release?.();
      }
      await checkpoint();
    };
    const asyncQueued = new Set(), terminalFiles = new Set(), fileJobs = new Map(), releasedFiles = new Set();
    const asyncReader = asyncVerification && readerAllocation ? wireScope(readerAllocation.scope('verification')) : undefined;
    const fileUnits = input.files.filter(file => file.eligibility === 'reviewable').map(file => ({ id: file.id, weight: 1 }));
    if (asyncReader && fileUnits.length) asyncAllocation = createReviewReaderAllocation(asyncReader, fileUnits);
    const releaseTerminalFile = id => {
      if (terminalFiles.has(id) && !(fileJobs.get(id) > 0) && !releasedFiles.has(id)) { asyncAllocation?.release(id); releasedFiles.add(id); }
    };
    if (asyncVerification) for (const item of plan.oversized) { terminalFiles.add(item.fileId); releaseTerminalFile(item.fileId); }
    if (asyncVerification) verificationQueue = createWholeVerificationQueue(async job => {
      try { await verifyCandidates(job); }
      finally { fileJobs.set(job.stage.fileId, fileJobs.get(job.stage.fileId) - 1); releaseTerminalFile(job.stage.fileId); }
    }, { concurrency: verificationConcurrency, signal, onFatal: error => { if (!signal.aborted) { fatalError ??= error; controller.abort(error); } } });
    const enqueueCandidates = (batch, ids) => {
      for (const id of ids) {
        const targets = report.findings.filter(finding => finding.fileId === id && !asyncQueued.has(finding));
        for (let offset = 0; offset < targets.length; offset += 50) {
          const selected = targets.slice(offset, offset + 50);
          selected.forEach(finding => asyncQueued.add(finding));
          // Only immutable candidate facts cross the phase boundary; origins/status
          // remain owned by the report and can accumulate without changing sent input.
          const candidates = selected.map(({ primaryOrigins, verification, ...finding }) => structuredClone(finding));
          const stage = { id: 'verification-file-' + reportOrder.get(id) + '-chunk-' + (offset / 50 + 1), fileId: id, batchId: batch.id, status: 'pending' };
          (report.orchestration.verifications ??= []).push(stage);
          fileJobs.set(id, (fileJobs.get(id) ?? 0) + 1);
          verificationQueue.enqueue({ candidates, targets: selected, batch, stage, candidateReader: wireScope(asyncAllocation.scope(id)) }, id);
        }
      }
    };
    const runBatch = async (batch, index, depth=0, ownStage) => {
      const stage = ownStage ?? report.orchestration.batches[index];
      let child;
      try {
        gate();
        if (parallelChildren) {
          child = await options.createBatchModel({ batchId: batch.id, fileIds: [...batch.fileIds], signal });
          if (!child || (typeof child.invoke !== 'function' && typeof child.runPrimary !== 'function') || typeof child.dispose !== 'function') throw new Error('Invalid host child model');
          if(typeof child.runPrimary==='function'&&!(child.retrievalTelemetry?.version===1&&child.retrievalTelemetry?.scope==='schema-authorization-range'&&child.retrievalTelemetry?.complete===true))telemetryCovered=false;
          signal.throwIfAborted();
        }
        const batchModel = child ? trackModel(request => child.invoke(request), batch.id) : trackedModel;
        const response = child?.runPrimary ? await child.runPrimary({ request: requestFor(batch), scope: primaryReader, maxRounds, maxInputBytes, enableInvestigationState: options.enableInvestigationState === true,
          reserveModelCall: () => { gate(); report.modelCalls++; const row = requestRecord('group-primary', batch.id, false); row.status = 'host-admitted-unobserved'; },
          onRetrieved: loopOptions(stage).onRetrieved, onBudgetLimited: loopOptions(stage).onBudgetLimited,
          onCapacityFinalOnly: () => { if (child?.transport === 'host-subagent') capacityStages.add(stage); },
          onTruncated: loopOptions(stage).onTruncated,
          onProgress: options.onProgress, onRetrievalProtocolUnobserved:()=>{telemetryCovered=false;}, onRetrievalProtocolError:()=>{report.orchestration.retrievalProtocol.invalidRequests++;protocolTelemetry.invalidRequests++;protocolTelemetry.childInvalidRequests++;}, onChildStarted:info=>{if(info.transport==='host-subagent')report.orchestration.retrievalProtocol.observed=true;stage.childId=info.childId;stage.execution='host-subagent';(report.orchestration.childrenStarted??=[]).push({childId:info.childId,batchId:batch.id});} }) : await retrievalLoop(batchModel, requestFor(batch), primaryReader, { ...loopOptions(stage), enableInvestigationState: options.enableInvestigationState === true });
        if (child?.transport === 'host-subagent') { stage.childId = child.childId; stage.execution = 'host-subagent'; }
        const validation = (options.enableMemberIsolation === true ? validateGroupPrimaryMembers : validateGroupPrimary)(response, batch, input, options.validateFindingResponse, reader.catalog(), { enableAnchorCorrection: options.enableAnchorCorrection === true, signal });
        const members = options.enableMemberIsolation === true ? validation.completed : validation;
        const failedMembers = options.enableMemberIsolation === true ? validation.failed : new Map();
        for (const [id, error] of failedMembers) {
          rejectedMemberIds.add(id);
          Object.assign(stateById.get(id), { status: 'failed', primaryStatus: 'failed', batchId: batch.id, failureCode: error.code, reason: error.reason });
          report.limitations.push({ fileId: id, text: error.reason });
        }
        if (failedMembers.size) stage.failedMembers = [...failedMembers].map(([fileId, error]) => ({ fileId, failureCode: error.code }));
        signal.throwIfAborted();
        // Validate the entire member set before publishing any member result.
        for (const [id, generated] of members) {
          if (rejectedMemberIds.has(id)) continue;
          const state = stateById.get(id);
          Object.assign(state, { status: stage.retrievalLimited ? 'pending' : 'completed', primaryStatus: stage.retrievalLimited ? 'pending' : 'completed', batchId: batch.id });
          if (generated.anchorCorrections) state.anchorCorrections = generated.anchorCorrections;
          if (stage.retrievalLimited) Object.assign(state, { retrievalLimited: true, retrievalLimits: structuredClone(stage.retrievalLimits) });
          else { delete state.retrievalLimited; delete state.retrievalLimits; delete state.failureCode; }
          (state.primaryAttempts ??= []).push({ batchId: batch.id, ...(stage.parentBatchId ? { parentBatchId: stage.parentBatchId } : {}), depth, status: state.primaryStatus, ...(stage.retrievalLimited ? { retrievalLimited: true, retrievalLimits: structuredClone(stage.retrievalLimits) } : {}) });
          for (const finding of generated.findings) {
            const key = JSON.stringify(canonical(finding));
            const origin = { batchId: batch.id, depth, ...(stage.parentBatchId ? { parentBatchId: stage.parentBatchId } : {}), limited: stage.retrievalLimited === true };
            const existing = findingByIdentity.get(key);
            if (existing) existing.primaryOrigins.push(origin);
            else { const published = { ...structuredClone(finding), primaryOrigins: [origin], verification: { status: 'pending', causality: 'unverified' } }; findingByIdentity.set(key, published); report.findings.push(published); }
          }
          report.limitations.push(...generated.limitations.map(text => ({ fileId: id, text })));
        }
        stage.status = failedMembers.size ? 'partial' : stage.retrievalLimited ? 'pending' : 'completed';
        verificationSources.push(batch);
        const completionSplit = capacityStages.has(stage) && stage.retrievalLimited && depth < 8 ? splitWholeBatch(batch) : null;
        if (completionSplit) {
          // Parent candidates and committed audit remain visible even if cleanup,
          // cancellation, a child or checkpoint fails during the fresh attempts.
          await checkpoint();
          if (child) { const parent = child; child = null; try { await parent.dispose(); } catch (cleanup) { fatalError ??= cleanup; controller.abort(cleanup); throw cleanup; } }
          signal.throwIfAborted();
          stage.status = 'capacity-superseded';
          stage.childBatchIds = completionSplit.map(smaller => smaller.id);
          (report.orchestration.capacityCompletions ??= []).push({ batchId: batch.id, childBatchIds: [...stage.childBatchIds], depth, approvedCap: maxInputBytes, modelSent: true });
          await checkpoint();
          for (const smaller of completionSplit) {
            signal.throwIfAborted();
            const childStage = { id: smaller.id, parentBatchId: batch.id, fileIds: [...smaller.fileIds], status: 'pending' };
            report.orchestration.batches.push(childStage);
            await runBatch(smaller, index, depth + 1, childStage);
          }
          return;
        }
        await checkpoint();
        if (asyncVerification && !stage.retrievalLimited) {
          // A failed leaf can still own an accepted capacity-parent candidate.
          // Admit it before declaring the file terminal and releasing its floor.
          enqueueCandidates(batch, [...members.keys(), ...failedMembers.keys()]);
          // Capacity parents return above; this terminal generation cannot add more.
          for (const id of [...members.keys(), ...failedMembers.keys()]) { terminalFiles.add(id); releaseTerminalFile(id); }
        }
      } catch (error) {
        signal.throwIfAborted();
        if (checkpointFailed || error.code === 'MODEL_ARTIFACT_FAILED') { fatalError ??= error; controller.abort(error); throw error; }
        const split=depth<8?splitUnsentChildBatch(batch,error,{approvedCap:maxInputBytes}):null;
        if(split){
          if(child){const rejected=child;child=null;try{await rejected.dispose();}catch(cleanup){fatalError??=cleanup;controller.abort(cleanup);throw cleanup;}}
          stage.status='split-before-send';stage.requiredBytes=error.requiredBytes;stage.approvedCap=maxInputBytes;stage.childBatchIds=split.map(smaller=>smaller.id);
          (report.orchestration.capacityReplans??=[]).push({batchId:batch.id,requiredBytes:error.requiredBytes,approvedCap:maxInputBytes,depth,childBatchIds:split.map(b=>b.id),modelSent:false});
          for(const smaller of split){signal.throwIfAborted();const childStage={id:smaller.id,parentBatchId:batch.id,fileIds:[...smaller.fileIds],status:'pending'};report.orchestration.batches.push(childStage);await runBatch(smaller,index,depth+1,childStage);}
          return;
        }
        stage.status = isBudget(error) ? 'pending' : 'failed';
        stage.failureCode = error.code ?? 'WHOLE_SCOPE_PRIMARY_FAILED'; stage.reason = error.message;
        if(Number.isSafeInteger(error.requiredBytes))stage.requiredBytes=error.requiredBytes;
        if(Number.isSafeInteger(error.approvedCap))stage.approvedCap=error.approvedCap;
        for (const id of batch.fileIds) if (!rejectedMemberIds.has(id)) Object.assign(stateById.get(id), { status: stage.status, primaryStatus: stage.status, failureCode: stage.failureCode, reason: error.message });
        report.limitations.push({ text: '整体主审未完成：' + error.message });
        if (asyncVerification) for (const id of batch.fileIds) if (!report.findings.some(finding => finding.fileId === id)) { terminalFiles.add(id); releaseTerminalFile(id); }
      } finally {
        if (child) { try { await child.dispose(); } catch (error) { fatalError ??= error; controller.abort(error); throw error; } }
      }
    };
    await runWholeScopeWorkers(plan.batches, (batch,index)=>runBatch(batch,index), { concurrency: report.orchestration.batchConcurrency, signal, onFatal: error => { if (!signal.aborted) { fatalError ??= error; controller.abort(error); } } });
    readerAllocation?.release('primary'); // All workers and their cleanup settled.
    if (asyncVerification) {
      // Pending/limited primary candidates are retained, never promoted to supported.
      // They may still receive a strict independent verdict after all primaries join.
      if (verificationSources.length) enqueueCandidates(verificationSources[0], input.files.map(file => file.id));
      for (const unit of fileUnits) { terminalFiles.add(unit.id); releaseTerminalFile(unit.id); }
      await verificationQueue.drain();
      for (const unit of fileUnits) asyncAllocation?.release(unit.id);
      report.orchestration.asyncVerification.readerAllocation = asyncAllocation?.summary();
    } else {
      const verificationReader = readerAllocation ? wireScope(readerAllocation.scope('verification')) : reader;
      const units = Array.from({ length: Math.ceil(report.findings.length / 50) }, (_, index) => ({ id: 'verification-' + (index + 1), weight: Math.min(50, report.findings.length - index * 50) }));
      const allocation = readerAllocation && units.length ? createReviewReaderAllocation(verificationReader, units) : undefined;
      report.findings.sort((a, b) => reportOrder.get(a.fileId) - reportOrder.get(b.fileId));
      for (let offset = 0; offset < report.findings.length; offset += 50) {
        const targets = report.findings.slice(offset, offset + 50);
        const stage = { id: 'verification-' + (offset / 50 + 1), status: 'pending' };
        (report.orchestration.verifications ??= []).push(stage);
        await verifyCandidates({ candidates: targets.map(({ primaryOrigins, verification, ...finding }) => structuredClone(finding)), targets, batch: verificationSources[0], stage,
          candidateReader: allocation ? wireScope(allocation.scope(stage.id)) : verificationReader, release: () => allocation?.release(stage.id) });
      }
    }
    readerAllocation?.release('verification');
    for (const state of report.files) {
      const candidates = report.findings.filter(finding => finding.fileId === state.fileId);
      if (candidates.length) state.verificationStatus = candidates.every(finding => finding.verification.status === 'completed') ? 'completed' : 'pending';
    }
    report.findings.sort((a, b) => reportOrder.get(a.fileId) - reportOrder.get(b.fileId) || JSON.stringify(a.anchor).localeCompare(JSON.stringify(b.anchor)) || a.title.localeCompare(b.title));
    if (asyncVerification) report.orchestration.verifications?.sort((a, b) => reportOrder.get(a.fileId) - reportOrder.get(b.fileId) || a.id.localeCompare(b.id));
    const reviewable = input.files.filter(file => file.eligibility === 'reviewable').length;
    if (!reviewable) report.limitations.push({ text: '没有可审查文件，没有执行整体主审。' });
    report.coverage = { total: report.files.length, ...Object.fromEntries(['completed', 'excluded', 'blocked', 'failed', 'cancelled', 'pending'].map(status => [status, report.files.filter(file => file.status === status).length])) };
    report.orchestration.primaryComplete = plan.batches.length === 1 && !plan.oversized.length && reviewable > 0 && report.files.every(file => ['completed', 'excluded'].includes(file.status));
    const unfinished = report.files.some(file => !['completed', 'excluded'].includes(file.status)) || report.findings.some(finding => finding.verification.status !== 'completed');
    report.status = unfinished || report.limitations.length || plan.batches.length !== 1 ? 'partial' : 'completed';
    if (report.coverage.failed && !report.coverage.completed) report.status = 'failed';
    if (readerAllocation) report.readerAllocation = readerAllocation.summary();
    report.readerUsage = reader.usage(); report.retrievalUsage = report.readerUsage;
    report.retrievalSources = reader.catalog(); report.readerBudget = { ...reader.usage(), ...reader.budget() };
    report.finishedAt = new Date().toISOString();
    publishProtocolTelemetry(true);
    await options.onProgress?.({ stage: 'batch-complete', snapshotId: input.id, files: report.files, findings: report.findings, limitations: report.limitations });
    return report;
  } catch (error) {
    const alreadyAborted = signal.aborted;
    if (!alreadyAborted) controller.abort(error);
    await verificationQueue?.drain().catch(() => {});
    if (fatalError) throw fatalError;
    if (!alreadyAborted || checkpointFailed || error.code === 'MODEL_ARTIFACT_FAILED') throw error;
    if (!report.files.length) report.files = input.files.map(file => ({ fileId: file.id, path: file.path, status: file.eligibility === 'reviewable' ? 'cancelled' : file.eligibility }));
    for (const state of report.files) if (state.status === 'pending') state.status = 'cancelled';
    const cancelledOrder = new Map(input.files.map((file, index) => [file.id, index]));
    report.findings.sort((a, b) => cancelledOrder.get(a.fileId) - cancelledOrder.get(b.fileId));
    for (const finding of report.findings) if (finding.verification?.status !== 'completed') finding.verification = { status: 'incomplete', causality: 'unverified' };
    report.status = 'cancelled';
    report.limitations.push({ text: '整体审查已取消或超时；已验收成果保留，其他范围未完成。' });
    report.coverage = { total: report.files.length, ...Object.fromEntries(['completed', 'excluded', 'blocked', 'failed', 'cancelled', 'pending'].map(status => [status, report.files.filter(file => file.status === status).length])) };
    report.finishedAt = new Date().toISOString();
    if (reader) { report.readerUsage = reader.usage(); report.readerBudget = { ...reader.usage(), ...reader.budget() }; }
    publishProtocolTelemetry(false);
    await checkpoint();
    return report;
  } finally {
    await verificationQueue?.drain().catch(() => {});
    // Worker runner joins active children before control reaches this boundary.
    readerAllocation?.release('primary');
    readerAllocation?.release('verification');
    if (readerAllocation) report.readerAllocation = readerAllocation.summary();
    try { await checkpoints.drain(); } catch (error) { throw fatalError ?? error; } finally { clearTimeout(timer); }
  }
}
