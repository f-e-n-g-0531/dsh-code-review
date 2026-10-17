import { RETRIEVAL_INSTRUCTIONS } from './prompts.mjs';
import { executeRetrievalBatch } from './retrieval-protocol.mjs';

export { RETRIEVAL_INSTRUCTIONS };

function compactFollowup(input) {
  const p = JSON.parse(input);
  if (p.windows) {
    p.windows = p.windows.map(w => ({ ...w, old: { ...w.old, text: undefined }, new: { ...w.new, text: undefined } }));
    p.windowBodyNotice = 'Window bodies deferred; use approved catalog read. Omitted results are not evidence.';
  }
  if (p.sourceMode === 'window-synthesis') {
    for (const key of ['contextRelations', 'contextRelationNotice', 'cppCallSites', 'cppCallNotice', 'callerBindings', 'callerBindingNotice', 'windowNotice', 'defectGuidance', 'contextNotice', 'contextMode']) delete p[key];
    if (p.changes) p.changes = { status: p.changes.status, precision: p.changes.precision, edits: p.changes.edits };
    p.followupNotice = 'Synthesis metadata compacted; windowIndex retains original coordinates. Read approved sides for evidence.';
  }
  return JSON.stringify(p);
}

export function retrievalRequest(request, scope, retrieved = []) {
  return { ...request, instructions: request.instructions + '\n' + RETRIEVAL_INSTRUCTIONS, input: JSON.stringify({ ...JSON.parse(request.input), catalog: scope.catalog(), retrieved }) };
}

function recordRetrieval(operation, result, onTruncated, onRetrieved) {
  if (result.truncated === true) onTruncated();
  onRetrieved([{
    kind: operation.kind, snapshotId: result.snapshotId, stage: 'retrieved-locally',
    ...(operation.kind === 'read'
      ? { sourceId: result.sourceId, hash: result.hash, start: result.start, count: result.count }
      : { matches: result.matches.map(match => ({ ...match })), truncated: result.truncated }),
    resultBytes: Buffer.byteLength(JSON.stringify(result)),
  }]);
}

const CORRECTION_SUFFIX = ' 本次是检索协议纠正：上次请求整批未执行。只返回requests数组，不带findings/limitations；read使用catalog的id和整数start/count，不用path/end。或直接返回当前阶段最终schema。不得扩大批准来源。';

export async function retrievalLoop(model, request, scope, { correctProtocol = false, maxRounds = Number.MAX_SAFE_INTEGER, maxInputBytes = 96 * 1024, beforeCall = () => {}, onTruncated = () => {}, onRetrieved = () => {} } = {}) {
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 0 || !Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1) throw new Error('Invalid retrieval loop budget');
  const retrieved = [];
  let protocolCorrection;
  for (let round = 0; ; round++) {
    request.signal?.throwIfAborted();
    let { input, instructions: baseInstructions } = retrievalRequest(request, scope, retrieved);
    const instructions = baseInstructions + (protocolCorrection ? CORRECTION_SUFFIX : '');
    if (correctProtocol && retrieved.length && Buffer.byteLength(input) + Buffer.byteLength(instructions) > maxInputBytes) input = compactFollowup(input);
    if (Buffer.byteLength(input) + Buffer.byteLength(instructions) > maxInputBytes) throw new Error('Retrieval input budget exceeded');
    beforeCall();
    const response = await model({ ...request, instructions, input });
    request.signal?.throwIfAborted();
    const serialized = typeof response === 'string' ? response : JSON.stringify(response);
    if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > 128 * 1024) throw new Error('Retrieval response too large');
    const parsed = JSON.parse(serialized);
    if (!parsed || !Object.hasOwn(parsed, 'requests')) return parsed;
    if (round >= maxRounds) throw new Error('Retrieval round budget exceeded');
    let batch;
    try {
      batch = executeRetrievalBatch(parsed, scope, request.signal, ({ request: operation, result }) => recordRetrieval(operation, result, onTruncated, onRetrieved));
    } catch (error) {
      request.signal?.throwIfAborted();
      if (!correctProtocol || protocolCorrection || !(/Invalid retrieval batch|Invalid read request|Invalid search request|Invalid find request/.test(error.message))) throw error;
      protocolCorrection = { code: error.code ?? 'MODEL_INVALID_RETRIEVAL' };
      await request.onProtocolEvent?.({ action: 'retrieval-protocol-correction', code: protocolCorrection.code });
      continue;
    }
    for (const item of batch) {
      let candidate = [...retrieved, item];
      let next = retrievalRequest(request, scope, candidate);
      if (correctProtocol) {
        while (retrieved.length && Buffer.byteLength(compactFollowup(next.input)) + Buffer.byteLength(next.instructions) > maxInputBytes) {
          retrieved.shift();
          await request.onProtocolEvent?.({ action: 'prior-retrieval-deferred', notice: 'Prior returned fragment no longer in current prompt; reread approved source for evidence.' });
          candidate = [...retrieved, item];
          next = retrievalRequest(request, scope, candidate);
        }
      }
      let fits = Buffer.byteLength(next.input) + Buffer.byteLength(next.instructions) <= maxInputBytes;
      if (correctProtocol && !fits) fits = Buffer.byteLength(compactFollowup(next.input)) + Buffer.byteLength(next.instructions) <= maxInputBytes;
      if (correctProtocol && !fits) {
        const omitted = { request: item.request, result: { omitted: true, reason: 'Result omitted: request fewer lines/matches; no body or receipt provided.' } };
        const minimal = retrievalRequest(request, scope, [...retrieved, omitted]);
        if (Buffer.byteLength(compactFollowup(minimal.input)) + Buffer.byteLength(minimal.instructions) > maxInputBytes) throw new Error('Retrieval input metadata exceeds model capacity');
        retrieved.push(omitted);
        await request.onProtocolEvent?.({ action: 'oversized-retrieval-omitted', kind: item.request.kind });
      } else {
        retrieved.push(item);
      }
    }
  }
}
