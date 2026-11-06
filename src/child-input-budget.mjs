import { modelResultTools } from './model-tools.mjs';
import { childOutputSchema } from './child-output-schema.mjs';

export const DEFAULT_CHILD_HOST_RESERVE_BYTES = 64 * 1024;
const CHILD_INSTRUCTIONS = '\nThe complete member bodies already in reviews are approved primary-review input; use them directly without rereading for receipts or line numbers. Use review_snapshot only for necessary supplemental approved sources not already supplied, not to repeat all member bodies. Preserve this child context for supplemental reads. Return final reviews via structured_output, never requests.\n';
const invalid = message => { throw new TypeError(message); };
function inputValue(request) {
  if (!request || typeof request.instructions !== 'string' || typeof request.input !== 'string') invalid('Invalid review child request');
  const input = JSON.parse(request.input);
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Invalid review child input');
  return input;
}

// This exact text must be used for startActivation.prompt, not a separate planner
// reconstruction. JSON serialization preserves every approved member/body byte.
export function buildReviewChildPrompt(request, scope) {
  const input = inputValue(request);
  if (typeof scope?.catalog !== 'function' || typeof scope?.budget !== 'function') invalid('Invalid approved child scope');
  return request.instructions + CHILD_INSTRUCTIONS + JSON.stringify({ ...input, catalog: scope.catalog(), retrievalBudget: scope.budget() });
}

export function buildReviewChildOutputSchema(request) {
  const input = inputValue(request);
  const finalEnvelope = { ...input, retrievalFinalization: { reason: 'Use review_snapshot tool for supplemental reading; structured_output submits final reviews only' } };
  const tool = modelResultTools(JSON.stringify(finalEnvelope), request.instructions)[0];
  if (!tool) invalid('Unsupported review child result stage');
  return childOutputSchema(tool.parameters);
}

// Known initial logical transport only: an initial user message and final schema.
// snapshotTool, when supplied, must be the same declaration installed by the host.
// Host system messages, tool descriptions/wrappers, history and runtime transforms
// are NOT inferred here. The explicit reserve is policy, never a runtime guarantee.
export function buildReviewChildInitialEnvelope(request, scope, { snapshotTool } = {}) {
  if (snapshotTool !== undefined && (!snapshotTool || typeof snapshotTool !== 'object' || Array.isArray(snapshotTool) || snapshotTool.name !== 'review_snapshot' || !snapshotTool.parameters || typeof snapshotTool.parameters !== 'object')) invalid('Invalid snapshot tool declaration');
  return { messages: [{ role: 'user', content: [{ type: 'text', text: buildReviewChildPrompt(request, scope) }] }], tools: [
    ...(snapshotTool === undefined ? [] : [structuredClone(snapshotTool)]),
    { name: 'structured_output', parameters: buildReviewChildOutputSchema(request) },
  ] };
}

export function measureChildInitialInput(request, scope, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['maxInputBytes', 'hostReserveBytes', 'snapshotTool'].includes(key))) invalid('Invalid child input measurement options');
  const { maxInputBytes, hostReserveBytes = DEFAULT_CHILD_HOST_RESERVE_BYTES, snapshotTool } = options;
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1 || !Number.isSafeInteger(hostReserveBytes) || hostReserveBytes < 0) invalid('Invalid child capacity or declared host reserve');
  const envelope = buildReviewChildInitialEnvelope(request, scope, { snapshotTool });
  const transportBytes = Buffer.byteLength(JSON.stringify(envelope));
  const requiredBytes = transportBytes + hostReserveBytes;
  if (!Number.isSafeInteger(requiredBytes)) invalid('Child transport measurement exceeds safe integer');
  return Object.freeze({ measurement: 'child-initial-logical-envelope', transportBytes, hostReserveBytes, requiredBytes,
    maxInputBytes, availableBytes: Math.max(0, maxInputBytes - hostReserveBytes),
    fits: requiredBytes <= maxInputBytes, includesSnapshotTool: snapshotTool !== undefined,
    runtimeGuarantee: false });
}
