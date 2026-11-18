import { reviewEffortPolicy } from './review-effort.mjs';
import { PROJECT_REVIEW_INSTRUCTIONS } from './prompts.mjs';
import { createReviewReader, reviewSnapshot } from './review.mjs';
import { preparePrimaryInput } from './primary-input.mjs';
import { initialRetrievalEnvelope } from './retrieval-initial-envelope.mjs';
import { modelWireBudget } from './model-wire-budget.mjs';
import { retrievalRounds, verificationRetrievalRounds } from './review-execution-policy.mjs';

export const DEFAULT_PROJECT_CONCURRENCY = 8;
export const PROJECT_MAX_INPUT_BYTES = 96 * 1024;
export const PROJECT_GROUP_PRIMARY = false;
const PROJECT_FILE_STATES = ['completed', 'excluded', 'blocked', 'failed', 'cancelled', 'pending'];

export function projectInputLimit(value = PROJECT_MAX_INPUT_BYTES) {
  if (!Number.isSafeInteger(value) || value < 1 || value > PROJECT_MAX_INPUT_BYTES) throw new Error('Project model input limit must be a positive integer at most 96KiB');
  return value;
}

export function projectCoverage(files) {
  const coverage = { total: files.length, ...Object.fromEntries(PROJECT_FILE_STATES.map(status => [status, 0])) };
  for (const file of files) {
    if (!PROJECT_FILE_STATES.includes(file.status)) throw new Error('Unexpected terminal project file status');
    coverage[file.status]++;
  }
  return coverage;
}
export function projectConcurrency(value = DEFAULT_PROJECT_CONCURRENCY) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 8) throw new Error('Project concurrency must be an integer from 1 to 8');
  return value;
}

const projectInstructions = effort => PROJECT_REVIEW_INSTRUCTIONS + '\nReview focus (not proof): ' + JSON.stringify(effort.checks);

// Same staged primary planner and an untouched instance of the batch reader.
// Running members may consume shared reader allowance before later stages.
export function projectPreviewFiles(batch, { reviewEffortMode, maxInputBytes, maxRetrievalRounds, nativeOutputTools, resumeState, signal }) {
  const scope = createReviewReader(batch, { nativeOutputTools, signal });
  const instructions = projectInstructions(reviewEffortPolicy(batch, { mode: reviewEffortMode }));
  const reusable = new Set(resumeState?.completed?.map(file => file.fileId));
  return batch.files.map(file => {
    signal?.throwIfAborted();
    const row = { path: file.path, eligibility: file.eligibility, reason: file.reason };
    if (file.eligibility !== 'reviewable' || reusable.has(file.id)) return row;
    const prepared = preparePrimaryInput(batch, file, { instructions, scope, maxInputBytes, maxRetrievalRounds });
    const request = initialRetrievalEnvelope({ instructions, input: prepared.payload, maxRetrievalRounds }, scope);
    const initial = modelWireBudget({ ...request, nativeOutputTools }, maxInputBytes);
    return { ...row, initialInputBytes: initial.bytes, initialInputFits: initial.fits };
  });
}

// Parallelize independent approved snapshots, never dependent stages within a batch.
// Admission and the shared call reservation are synchronous; completion order is not report order.
export async function reviewProjectBatches(batches, model, { concurrency = DEFAULT_PROJECT_CONCURRENCY, reviewEffortMode = 'auto', enableCounterVerification = false, remainingCalls, signal, onProgress, maxRetrievalRounds = 3, maxVerificationRetrievalRounds, resumeStates, onResumeCheckpoint, onModelArtifact, maxInputBytes = PROJECT_MAX_INPUT_BYTES, nativeOutputTools = false } = {}) {
  projectConcurrency(concurrency);
  projectInputLimit(maxInputBytes);
  retrievalRounds(maxRetrievalRounds);
  maxVerificationRetrievalRounds = verificationRetrievalRounds(maxVerificationRetrievalRounds, maxRetrievalRounds);
  if (!Array.isArray(batches) || typeof remainingCalls !== 'function') throw new Error('Invalid project execution');
  const controller = new AbortController();
  const batchSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const results = new Array(batches.length);
  let next = 0, failed = false, failure;
  const reportUnstarted = async (batch, index, cancelled) => {
    const files = batch.files.map(f => ({ fileId: f.id, path: f.path, ...(f.eligibility === 'reviewable'
      ? (cancelled ? { status: 'cancelled', reason: '项目批次启动前已取消', failureCode: 'CANCELLED' }
        : { status: 'pending', reason: '项目共享模型调用预算耗尽，未启动批次', failureCode: 'PROJECT_MODEL_CALL_LIMIT' })
      : { status: f.eligibility, reason: f.reason }) }));
    const result = { snapshotId: batch.id, status: cancelled ? 'cancelled' : 'partial', coverage: projectCoverage(files), files, findings: [], limitations: [], modelCalls: 0 };
    await onProgress?.({ stage: 'batch-complete', snapshotId: batch.id, batchIndex: index, files, findings: [], limitations: [] });
    return result;
  };
  const worker = async () => {
    while (!failed) {
      const index = next++;
      if (index >= batches.length) return;
      const batch = batches[index];
      try {
        const resumeState = resumeStates?.get(batch.id);
        const availableCalls = remainingCalls();
        if (batchSignal.aborted || availableCalls <= 0 && !resumeState?.completed?.length) {
          results[index] = await reportUnstarted(batch, index, batchSignal.aborted);
          continue;
        }
        const effort=reviewEffortPolicy(batch,{mode:reviewEffortMode});
        results[index] = await reviewSnapshot(batch, model, {
          instructions: projectInstructions(effort),
          enableCounterVerification:enableCounterVerification && effort.counterVerification.eligible,
          signal: batchSignal, maxInputBytes, maxCalls: Math.max(1, availableCalls), remainingCalls, enableRetrieval: true, enableVerification: true,
          enableGroupPrimary: PROJECT_GROUP_PRIMARY, nativeOutputTools, enableAnchorCorrection: true, correctProtocol: true, maxRetrievalRounds, maxVerificationRetrievalRounds,
          resumeState, onResumeCheckpoint: onResumeCheckpoint ? report => onResumeCheckpoint(batch, report) : undefined, onModelArtifact,
          onProgress: onProgress ? event => onProgress({ ...event, snapshotId: batch.id, batchIndex: index }) : undefined,
        });
      } catch (error) {
        if (!failed) { failed = true; failure = error; controller.abort(error); }
      }
    }
  };
  // Never release service ownership while a sibling model/cleanup is still running.
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  if (failed) throw failure;
  return results;
}
