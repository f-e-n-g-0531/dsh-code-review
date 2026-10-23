import { reviewSnapshot } from './review.mjs';
import { retrievalRounds } from './review-execution-policy.mjs';

export const DEFAULT_PROJECT_CONCURRENCY = 8;
export function projectConcurrency(value = DEFAULT_PROJECT_CONCURRENCY) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 8) throw new Error('Project concurrency must be an integer from 1 to 8');
  return value;
}

// Parallelize independent approved snapshots, never dependent stages within a batch.
// Admission and the shared call reservation are synchronous; completion order is not report order.
export async function reviewProjectBatches(batches, model, { concurrency = DEFAULT_PROJECT_CONCURRENCY, remainingCalls, signal, onProgress, maxRetrievalRounds = 3, resumeStates, onResumeCheckpoint, onModelArtifact, enableGroupPrimary = false, nativeOutputTools = false } = {}) {
  projectConcurrency(concurrency);
  retrievalRounds(maxRetrievalRounds);
  if (!Array.isArray(batches) || typeof remainingCalls !== 'function') throw new Error('Invalid project execution');
  const controller = new AbortController();
  const batchSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const results = new Array(batches.length);
  let next = 0, failed = false, failure;
  const unstarted = batch => ({ snapshotId: batch.id, status: 'partial', files: batch.files.map(f => ({ fileId: f.id, path: f.path, status: f.eligibility === 'reviewable' ? 'pending' : f.eligibility, reason: 'Session project budget exhausted or cancelled' })), findings: [], limitations: [] });
  const worker = async () => {
    while (!failed) {
      const index = next++;
      if (index >= batches.length) return;
      const batch = batches[index];
      try {
        if (batchSignal.aborted || remainingCalls() <= 0) { results[index] = unstarted(batch); continue; }
        results[index] = await reviewSnapshot(batch, model, {
          signal: batchSignal, maxCalls: remainingCalls(), remainingCalls, enableRetrieval: true, enableVerification: true,
          enableGroupPrimary, nativeOutputTools, enableAnchorCorrection: true, correctProtocol: true, maxRetrievalRounds,
          resumeState: resumeStates?.get(batch.id), onResumeCheckpoint: onResumeCheckpoint ? report => onResumeCheckpoint(batch, report) : undefined, onModelArtifact,
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
