import { REVIEW_INSTRUCTIONS } from './prompts.mjs';
import { createReviewReader } from './review.mjs';
import { prepareWholeScope } from './whole-scope-plan.mjs';
import { retrievalLoop } from './retrieval-loop.mjs';
import { verificationLoop } from './verification-loop.mjs';
import { validateGroupPrimary } from './group-primary.mjs';
import { modelWireBudget } from './model-wire-budget.mjs';
import { retrievalRounds } from './review-execution-policy.mjs';
import { validateBusinessRequirement } from './business-requirement.mjs';

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
  if (options.enableAnchorCorrection !== undefined && typeof options.enableAnchorCorrection !== 'boolean') throw new Error('Invalid anchor correction option');
  const maxRounds = retrievalRounds(options.maxRetrievalRounds);
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
    orchestration: { strategy: 'whole-scope', wholeScope: true, modelMetrics: {}, modelCallPurposes: {}, batches: [] },
    interactions: [], rules: (input.rules ?? []).map(({ path, hash }) => ({ path, hash })),
  };
  const stateById = new Map();
  let reader, checkpointFailed = false;
  const checkpoint = async () => {
    if (!options.onResumeCheckpoint) return;
    try { await options.onResumeCheckpoint(structuredClone(report)); } catch (error) { checkpointFailed = true; throw error; }
  };
  const gate = () => {
    signal.throwIfAborted();
    if (report.modelCalls >= maxCalls) throw failure('WHOLE_SCOPE_MODEL_CALL_LIMIT', 'Model call budget exceeded');
    if (options.remainingCalls?.() <= 0) throw failure('PROJECT_MODEL_CALL_LIMIT', 'Shared project model call limit exceeded');
  };
  const trackedModel = async request => {
    gate();
    if (!modelWireBudget(request, maxInputBytes).fits) throw failure('WHOLE_SCOPE_INPUT_BUDGET', 'Actual model wire input budget exceeded');
    report.modelCalls++;
    const result = await model({ ...request, maxInputBytes,
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
        (report.orchestration.modelCorrections ??= []).push(info);
        await options.onProtocolCorrection?.(info);
      },
      onModelEvent: async info => {
        if (info.action === 'model-end') {
          const metrics = report.orchestration.modelMetrics[request.reviewPhase] ??= { calls: 0, durationMs: 0, inputBytes: 0, totalOutputBytes: 0 };
          metrics.calls++;
          for (const key of ['durationMs', 'inputBytes', 'totalOutputBytes']) metrics[key] += Number.isFinite(info[key]) ? info[key] : 0;
          if (info.callPurpose) report.orchestration.modelCallPurposes[info.callPurpose] = (report.orchestration.modelCallPurposes[info.callPurpose] ?? 0) + 1;
        }
        await options.onModelEvent?.(info);
        await options.onProgress?.({ stage: info.action, snapshotId: input.id, phase: request.reviewPhase, ...info });
      },
    });
    signal.throwIfAborted();
    return result;
  };
  const requestFor = batch => ({ input: batch.payload, instructions: batch.instructions, signal,
    reviewPhase: 'group-primary', nativeOutputTools: options.nativeOutputTools === true,
    onProtocolEvent: options.onProtocolEvent });
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
    const plan = prepareWholeScope(input, { instructions: options.instructions ?? REVIEW_INSTRUCTIONS, scope: reader, maxInputBytes });
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
    report.scopeNotices = [{ text: '整体主审结合当前 batch 完整文件；批准关联源须按需检索，不声明专门 interaction 阶段或全部上下文覆盖。' }];
    const generatedBatches = [];
    for (const batch of plan.batches) {
      const stage = { id: batch.id, fileIds: [...batch.fileIds], status: 'pending' };
      report.orchestration.batches.push(stage);
      try {
        gate();
        const response = await retrievalLoop(trackedModel, requestFor(batch), reader, loopOptions(stage));
        const members = validateGroupPrimary(response, batch, input, options.validateFindingResponse, reader.catalog(), { enableAnchorCorrection: options.enableAnchorCorrection === true, signal });
        signal.throwIfAborted();
        // Validate the entire member set before publishing any member result.
        for (const [id, generated] of members) {
          const state = stateById.get(id);
          Object.assign(state, { status: stage.retrievalLimited ? 'pending' : 'completed', primaryStatus: stage.retrievalLimited ? 'pending' : 'completed', batchId: batch.id });
          if (generated.anchorCorrections) state.anchorCorrections = generated.anchorCorrections;
          if (stage.retrievalLimited) Object.assign(state, { retrievalLimited: true, retrievalLimits: stage.retrievalLimits });
          report.findings.push(...generated.findings);
          report.limitations.push(...generated.limitations.map(text => ({ fileId: id, text })));
        }
        stage.status = stage.retrievalLimited ? 'pending' : 'completed';
        generatedBatches.push(batch);
        await checkpoint();
      } catch (error) {
        signal.throwIfAborted();
        if (checkpointFailed || error.code === 'MODEL_ARTIFACT_FAILED') throw error;
        stage.status = isBudget(error) ? 'pending' : 'failed';
        stage.failureCode = error.code ?? 'WHOLE_SCOPE_PRIMARY_FAILED'; stage.reason = error.message;
        for (const id of batch.fileIds) Object.assign(stateById.get(id), { status: stage.status, primaryStatus: stage.status, failureCode: stage.failureCode, reason: error.message });
        report.limitations.push({ text: '整体主审未完成：' + error.message });
        if (isBudget(error)) break;
      }
    }
    // One global verification queue, not a per-file chain. Receipt ownership and
    // primary-file regression checks remain entirely in verificationLoop.
    for (const finding of report.findings) finding.verification = { status: 'pending', causality: 'unverified' };
    for (let offset = 0; offset < report.findings.length; offset += 50) {
      const candidates = report.findings.slice(offset, offset + 50);
      const stage = { id: 'verification-' + (offset / 50 + 1), status: 'pending' };
      (report.orchestration.verifications ??= []).push(stage);
      try {
        gate(); // Do not prefetch receipt evidence for a vetoed model call.
        const verdicts = await verificationLoop(trackedModel, { ...requestFor(generatedBatches[0]), reviewPhase: 'verification' }, candidates, reader, loopOptions(stage));
        signal.throwIfAborted();
        candidates.forEach((finding, i) => { finding.verification = { status: 'completed', ...verdicts[i] }; });
        stage.status = stage.retrievalLimited ? 'pending' : 'completed';
        if (verdicts.some(v => v.verdict === 'uncertain' || v.verdict === 'supported' && !['introduced', 'preexisting'].includes(v.regression?.classification))) report.limitations.push({ text: '部分候选缺少充分复核证据或前后对照，保留不确定，不强行确认支持或本次引入。' });
      } catch (error) {
        signal.throwIfAborted();
        if (checkpointFailed || error.code === 'MODEL_ARTIFACT_FAILED') throw error;
        stage.status = 'failed'; stage.failureCode = error.code ?? 'WHOLE_SCOPE_VERIFICATION_FAILED'; stage.reason = error.message;
        candidates.forEach(finding => { finding.verification = { status: 'incomplete', causality: 'unverified' }; });
        report.limitations.push({ text: '候选批量复核未完成：' + error.message });
      }
    }
    for (const state of report.files) {
      const candidates = report.findings.filter(finding => finding.fileId === state.fileId);
      if (candidates.length) state.verificationStatus = candidates.every(finding => finding.verification.status === 'completed') ? 'completed' : 'pending';
    }
    const reviewable = input.files.filter(file => file.eligibility === 'reviewable').length;
    if (!reviewable) report.limitations.push({ text: '没有可审查文件，没有执行整体主审。' });
    report.coverage = { total: report.files.length, ...Object.fromEntries(['completed', 'excluded', 'blocked', 'failed', 'cancelled', 'pending'].map(status => [status, report.files.filter(file => file.status === status).length])) };
    report.orchestration.primaryComplete = plan.batches.length === 1 && !plan.oversized.length && reviewable > 0 && report.files.every(file => ['completed', 'excluded'].includes(file.status));
    const unfinished = report.files.some(file => !['completed', 'excluded'].includes(file.status)) || report.findings.some(finding => finding.verification.status !== 'completed');
    report.status = unfinished || report.limitations.length || plan.batches.length !== 1 ? 'partial' : 'completed';
    if (report.coverage.failed && !report.coverage.completed) report.status = 'failed';
    report.readerUsage = reader.usage(); report.retrievalUsage = report.readerUsage;
    report.retrievalSources = reader.catalog(); report.readerBudget = { ...reader.usage(), ...reader.budget() };
    report.finishedAt = new Date().toISOString();
    await options.onProgress?.({ stage: 'batch-complete', snapshotId: input.id, files: report.files, findings: report.findings, limitations: report.limitations });
    return report;
  } catch (error) {
    if (!signal.aborted || checkpointFailed || error.code === 'MODEL_ARTIFACT_FAILED') throw error;
    if (!report.files.length) report.files = input.files.map(file => ({ fileId: file.id, path: file.path, status: file.eligibility === 'reviewable' ? 'cancelled' : file.eligibility }));
    for (const state of report.files) if (state.status === 'pending') state.status = 'cancelled';
    for (const finding of report.findings) if (finding.verification?.status !== 'completed') finding.verification = { status: 'incomplete', causality: 'unverified' };
    report.status = 'cancelled';
    report.limitations.push({ text: '整体审查已取消或超时；已验收成果保留，其他范围未完成。' });
    report.coverage = { total: report.files.length, ...Object.fromEntries(['completed', 'excluded', 'blocked', 'failed', 'cancelled', 'pending'].map(status => [status, report.files.filter(file => file.status === status).length])) };
    report.finishedAt = new Date().toISOString();
    if (reader) { report.readerUsage = reader.usage(); report.readerBudget = { ...reader.usage(), ...reader.budget() }; }
    await checkpoint();
    return report;
  } finally {
    clearTimeout(timer);
  }
}
