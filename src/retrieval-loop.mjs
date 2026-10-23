import { RETRIEVAL_INSTRUCTIONS } from './prompts.mjs';
import { searchSeeds } from './search-seeds.mjs';
import { modelWireBudget } from './model-wire-budget.mjs';
import { executeRetrievalBatch, parseRetrievalResponse } from './retrieval-protocol.mjs';

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
  return { ...request, instructions: request.instructions + '\n' + RETRIEVAL_INSTRUCTIONS + BUDGET_SUFFIX, input: JSON.stringify({ ...JSON.parse(request.input), catalog: scope.catalog(), retrieved, ...(scope.budget ? { retrievalBudget: scope.budget() } : {}) }) };
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

const CORRECTION_SUFFIX = ' 本次是检索协议纠正：上次请求整批未执行。只返回requests数组，不带findings/limitations；read使用catalog的id和整数start/count，不用path/end。read的start不得超过该catalog来源lineCount，空源不可read；旧新侧行号必须分别核对。或直接返回当前阶段最终schema。不得扩大批准来源。';

const BUDGET_SUFFIX = ' retrievalBudget为宿主共享检索预算的当前余量，不是新授权。每项操作消耗一次call及实际序列化输出字节；不要请求超过余量的整批操作。预算将尽请及时按本阶段schema最终答复，只引用已提供证据，证据不足须保留限制或uncertain。';
const FINAL_SUFFIX = ' 检索预算最终答复：本次仅有一次最终schema答复机会，不得再返回requests。不得把缺证据变成无问题/已核查；只保留已提供且可严格验证的证据，其余说明限制或uncertain。不增加reader、模型调用、输入或超时预算。';
const budgetFailure = error => ['READER_CALL_BUDGET_EXCEEDED', 'READER_OUTPUT_BUDGET_EXCEEDED', 'RETRIEVAL_ROUND_BUDGET_EXCEEDED'].includes(error?.code);

function roundBudgetError() {
  const error = new Error('Retrieval round budget exceeded');
  error.code = 'RETRIEVAL_ROUND_BUDGET_EXCEEDED';
  return error;
}

export async function retrievalLoop(model, request, scope, { correctProtocol = false, maxRounds = Number.MAX_SAFE_INTEGER, maxInputBytes = 96 * 1024, beforeCall = () => {}, onTruncated = () => {}, onRetrieved = () => {}, onBudgetLimited = () => {}, initialRetrieved = [], allowExhaustedInitial = false, enableSearchSeeds = false } = {}) {
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 0 || !Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1) throw new Error('Invalid retrieval loop budget');
  // Only internal callers can seed this loop; the public model response cannot supply it.
  const allowedSeeds = new Set(scope.catalog().map(item => item.id));
  if (!Array.isArray(initialRetrieved) || initialRetrieved.length > 50 || initialRetrieved.some(item => item?.request?.kind !== 'read' || !allowedSeeds.has(item.request.id) || item.result?.sourceId !== item.request.id || typeof item.result?.text !== 'string')) throw new Error('Invalid initial retrieval evidence');
  const retrieved = structuredClone(initialRetrieved);
  if (retrieved.length) {
    const seeded = retrievalRequest(request, scope, retrieved);
    if (request.nativeOutputTools === true ? !modelWireBudget(seeded, maxInputBytes).fits : Buffer.byteLength(seeded.input) + Buffer.byteLength(seeded.instructions) > maxInputBytes) throw new Error('Initial retrieval input budget exceeded');
    // Publish only fragments admitted to an actual outgoing prompt below.
  }
  const delivered = new Set();
  let protocolCorrection, finalization, searchSeedAttempts = 0, currentRound = 0;
  const finalize = async error => {
    finalization = { code: error.code, reason: error.message, ...(scope.budget ? { budget: scope.budget() } : {}) };
    await onBudgetLimited(finalization);
    await request.onProtocolEvent?.({ action: 'retrieval-budget-finalization', ...finalization });
  };
  const checkExhausted = async round => {
    const budget = scope.budget?.();
    if (!finalization && budget && (budget.remainingCalls === 0 || budget.remainingOutputBytes === 0)) {
      const error = new Error(budget.remainingCalls === 0 ? 'Reader call budget exceeded' : 'Reader output budget exceeded');
      error.code = budget.remainingCalls === 0 ? 'READER_CALL_BUDGET_EXCEEDED' : 'READER_OUTPUT_BUDGET_EXCEEDED';
      await finalize(error);
    } else if (!finalization && round >= maxRounds) await finalize(roundBudgetError());
  };
  const fits = value => request.nativeOutputTools === true ? modelWireBudget(value, maxInputBytes).fits : Buffer.byteLength(value.input) + Buffer.byteLength(value.instructions) <= maxInputBytes;
  const nextRequest = records => {
    const next = retrievalRequest(request, scope, records);
    if (enableSearchSeeds) {
      const annotated = { input: JSON.stringify({ ...JSON.parse(next.input), retrievalRounds: { max: maxRounds, remaining: finalization ? 0 : Math.max(0, maxRounds - currentRound) } }),
        instructions: next.instructions + ' Batch independent exact reads/searches together (1..8). retrievalRounds is per-stage request turns, not reader calls or authority. Search-hit host reads may accompany results; supplied fragments are not complete coverage.' };
      // Optional guidance must not turn an otherwise admitted envelope into a block.
      if (fits({ ...next, ...annotated })) Object.assign(next, annotated);
    }
    if (finalization) {
      // The live ledger is already present in retrievalBudget. Do not duplicate it
      // or stack contradictory read/final guidance on a nearly full source envelope.
      next.input = JSON.stringify({ ...JSON.parse(next.input), retrievalFinalization: { code: finalization.code } });
      next.instructions = request.instructions + '\n' + RETRIEVAL_INSTRUCTIONS + FINAL_SUFFIX;
    }
    next.instructions += protocolCorrection && !finalization ? CORRECTION_SUFFIX : '';
    return next;
  };
  for (let round = 0; ; round++) {
    currentRound = round;
    request.signal?.throwIfAborted();
    if (round > 0 || !allowExhaustedInitial) await checkExhausted(round);
    let { input, instructions } = nextRequest(retrieved);
    if (correctProtocol && retrieved.length && !fits({ ...request, input, instructions })) input = compactFollowup(input);
    if (!fits({ ...request, input, instructions })) throw new Error('Retrieval input budget exceeded');
    request.signal?.throwIfAborted();
    beforeCall();
    request.signal?.throwIfAborted();
    for (const item of retrieved) {
      if (!item.result.omitted && !delivered.has(item)) {
        recordRetrieval(item.request, item.result, onTruncated, onRetrieved);
        delivered.add(item);
      }
    }
    request.signal?.throwIfAborted();
    const callPurpose = finalization ? 'budget-finalization' : round === 0 ? 'primary-initial' : 'retrieval-followup';
    const response = await model({ ...request, instructions, input, callPurpose });
    request.signal?.throwIfAborted();
    const serialized = typeof response === 'string' ? response : JSON.stringify(response);
    if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > 128 * 1024) throw new Error('Retrieval response too large');
    const parsed = JSON.parse(serialized);
    if (!parsed || !Object.hasOwn(parsed, 'requests')) return parsed;
    // Schema and authorization remain hard failures, including on the final turn.
    // Preflight all dynamic ranges and aggregate budgets before any capability.
    let batch;
    try {
      const operations = parseRetrievalResponse(parsed);
      const allowed = new Set(scope.catalog().map(item => item.id));
      if (operations.some(r => r.kind === 'read' ? !allowed.has(r.id) : r.sourceIds?.some(id => !allowed.has(id)))) throw new Error('Source not authorized');
      if (finalization) {
        const error = new Error(finalization.reason + '; final response required, no further retrieval permitted');
        error.code = 'RETRIEVAL_FINAL_RESPONSE_REQUIRED';
        throw error;
      }
      if (round >= maxRounds) throw roundBudgetError();
      scope.preflight?.(operations);
      const execute = () => executeRetrievalBatch(parsed, scope, request.signal);
      batch = scope.transaction ? scope.transaction(execute) : execute();
    } catch (error) {
      request.signal?.throwIfAborted();
      if (!finalization && budgetFailure(error)) { await finalize(error); continue; }
      if (finalization || !correctProtocol || protocolCorrection || !(/Invalid retrieval batch|Invalid read request|Invalid search request|Invalid find request|Invalid line range|Line range outside source/.test(error.message))) throw error;
      protocolCorrection = { code: error.code ?? 'MODEL_INVALID_RETRIEVAL' };
      await request.onProtocolEvent?.({ action: 'retrieval-protocol-correction', code: protocolCorrection.code });
      continue;
    }
    if (enableSearchSeeds && searchSeedAttempts < 2) {
      const { seeds, attempts } = searchSeeds(scope, request, batch, {
        existing: [...retrieved, ...batch], maxReads: 2 - searchSeedAttempts, maxInputBytes,
        buildRequest: records => {
          const next = nextRequest(records);
          // Account the larger next-turn metadata, not only this turn's envelope.
          const value = JSON.parse(next.input);
          if (value.retrievalRounds) value.retrievalRounds.remaining = Math.max(0, maxRounds - round - 1);
          if (round + 1 >= maxRounds) {
            value.retrievalFinalization = { code: 'RETRIEVAL_ROUND_BUDGET_EXCEEDED' };
            next.instructions = request.instructions + '\n' + RETRIEVAL_INSTRUCTIONS + FINAL_SUFFIX;
          }
          next.input = JSON.stringify(value);
          if (correctProtocol) next.input = compactFollowup(next.input);
          return next;
        }, signal: request.signal,
      });
      searchSeedAttempts += attempts;
      batch.push(...seeds);
    }
    await checkExhausted(round + 1);
    for (const item of batch) {
      let candidate = [...retrieved, item];
      let next = nextRequest(candidate);
      if (correctProtocol) {
        while (retrieved.length && !fits({ ...next, input: compactFollowup(next.input) })) {
          retrieved.shift();
          await request.onProtocolEvent?.({ action: 'prior-retrieval-deferred', notice: 'Prior returned fragment no longer in current prompt; reread approved source for evidence.' });
          candidate = [...retrieved, item];
          next = nextRequest(candidate);
        }
      }
      let admitted = fits(next);
      if (correctProtocol && !admitted) admitted = fits({ ...next, input: compactFollowup(next.input) });
      if (correctProtocol && !admitted) {
        const omitted = { request: item.request, result: { omitted: true, reason: 'Result omitted: request fewer lines/matches; no body or receipt provided.' } };
        const minimal = nextRequest([...retrieved, omitted]);
        if (!fits({ ...minimal, input: compactFollowup(minimal.input) })) throw new Error('Retrieval input metadata exceeds model capacity');
        retrieved.push(omitted);
        await request.onProtocolEvent?.({ action: 'oversized-retrieval-omitted', kind: item.request.kind });
      } else {
        retrieved.push(item);
      }
    }
  }
}
