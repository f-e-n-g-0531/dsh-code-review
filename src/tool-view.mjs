import { safeReviewFailure } from './review-failure.mjs';
// Shared tool output schema + renderer for the JSON+Markdown review tools.
const previewFields = new Set(['previewId', 'expiresAt', 'validForMs', 'snapshotId', 'reviewMode', 'repositoryRoot', 'vcs', 'changeScope', 'workingScope', 'history', 'model', 'modelSendingEnabled', 'files', 'filePage', 'contextPaths', 'oldContextPaths', 'plan', 'dispatch', 'execution', 'totalTrackedNodes', 'selectedFiles', 'selectionComplete', 'inventoryComplete', 'inventoryScope', 'batches', 'rules', 'businessRequirement', 'contextSources', 'oldContextSources', 'callerDiscovery', 'autoContext']);
const metadataFields = new Set(['provider', 'model', 'reasoningEffort', 'path', 'oldPath', 'status', 'eligibility', 'reason', 'hash', 'oldHash', 'newHash', 'oldBytes', 'newBytes', 'bytes', 'vcs', 'kind', 'mode', 'scope', 'baseline', 'revision', 'baseRevision', 'targetRevision', 'from', 'to', 'commit', 'base', 'target', 'url', 'repositoryUuid', 'offset', 'limit', 'total', 'minimumCalls', 'fileCount', 'eligibleFiles', 'excludedFiles', 'primaryGroups', 'files', 'paths', 'id', 'index', 'sourceBytes', 'inputBytes', 'maxInputBytes', 'requestedStrategy', 'effectiveStrategy', 'executionStrategy', 'reasonCode', 'plannedChildCount', 'batchExecution', 'batchConcurrency', 'fileConcurrency', 'maxRetrievalRounds', 'nativeOutputTools', 'resumeSupported', 'requested', 'childMode', 'eligibleCount', 'oversizedCount', 'concurrency', 'fileIds', 'fileId', 'baseUrl', 'targetUrl', 'crossUrl', 'pegRevision', 'operativeRevision', 'textHash', 'propertyHash', 'side', 'contextSide', 'contextVersion', 'version', 'blobOid', 'svnSource', 'old', 'new', 'scopes', 'scanned', 'scannedBytes', 'records', 'probeCount', 'candidates', 'capturedPaths', 'incomplete', 'fromPath', 'toPath', 'targetPath', 'sourcePath', 'line', 'start', 'count', 'specifier', 'referenceKind', 'workingSource', 'replacementSource', 'copySource', 'sides', 'truncated', 'maxDepth', 'depth', 'capacityRecovery', 'enabled', 'additionalCalls', 'sharedBudgetsUnchanged']);
function metadata(value, depth = 0) {
  if (depth > 8) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, 4096);
  if (Array.isArray(value)) return value.slice(0, 1000).map(item => metadata(item, depth + 1));
  if (!value || typeof value !== 'object') return undefined;
  return Object.fromEntries(Object.entries(value).filter(([key]) => metadataFields.has(key)).map(([key, item]) => [key, metadata(item, depth + 1)]));
}
function previewMetadata(key, value) {
  if (key === 'businessRequirement') return { ...(typeof value?.hash === 'string' ? { hash: value.hash } : {}), ...(Number.isSafeInteger(value?.bytes) && value.bytes >= 0 ? { bytes: value.bytes } : {}), textOmitted: true };
  return metadata(value);
}
function render(_args, value) {
  if (!value.markdown) return [{ type: 'text', text: value.json }];
  let parsed;
  try { parsed = JSON.parse(value.json); } catch { return [{ type: 'text', text: value.markdown }]; }
  if (!parsed || typeof parsed !== 'object' || parsed.sourceBearing === true) return [{ type: 'text', text: value.markdown }];
  const preview = parsed.resultSummary?.previewId ? parsed.resultSummary : parsed.previewId ? parsed : undefined;
  let extra;
  if (preview && typeof preview.previewId === 'string') {
    extra = { ...(typeof parsed.jobId === 'string' ? { jobId: parsed.jobId } : {}), ...(typeof parsed.status === 'string' ? { status: parsed.status } : {}), ...Object.fromEntries(Object.entries(preview).filter(([key]) => previewFields.has(key)).map(([key, item]) => [key, previewMetadata(key, item)])) };
  } else if (parsed.status === 'failed') {
    extra = {status:'failed',...(typeof parsed.jobId==='string'?{jobId:parsed.jobId.slice(0,200)}:{}),failure:safeReviewFailure(parsed.failure??{})};
  }
  return [{ type: 'text', text: extra ? value.markdown + String.fromCharCode(10, 10) + JSON.stringify(extra) : value.markdown }];
}
export const reviewToolOutput = {
  schema: { type: 'object', additionalProperties: false, properties: { json: { type: 'string' }, markdown: { type: 'string' } }, required: ['json', 'markdown'] },
  render,
};
