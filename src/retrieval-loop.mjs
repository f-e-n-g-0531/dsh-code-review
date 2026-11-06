import { transferReceiptPolicy } from './verification-receipt-policy.mjs';
import { RETRIEVAL_INSTRUCTIONS } from './prompts.mjs';
import { searchSeeds } from './search-seeds.mjs';
import { modelWireBudget } from './model-wire-budget.mjs';
import { executeRetrievalBatch, parseRetrievalResponse } from './retrieval-protocol.mjs';

export { RETRIEVAL_INSTRUCTIONS };

function compactFollowup(input) {
  const p = JSON.parse(input);
  let removed = false;
  const strip = (source, keys = ['text']) => {
    if (!source || typeof source !== 'object') return;
    for (const key of keys) if (typeof source[key] === 'string' && source[key].length) {
      delete source[key];
      removed = true;
    }
  };
  const file = value => {
    if (!value || typeof value !== 'object') return;
    // Full snapshot files use left/right; windows use old/new. Never traverse
    // arbitrary claims, exact edits, or retrieved results looking for text.
    for (const side of ['left', 'right', 'old', 'new']) strip(value[side]);
  };
  const envelope = value => {
    file(value.file);
    for (const key of ['relatedFiles', 'files', 'windows']) {
      if (Array.isArray(value[key])) value[key].forEach(file);
    }
    if (Array.isArray(value.context)) value.context.forEach(item => strip(item, ['text', 'oldText']));
  };
  envelope(p);
  if (Array.isArray(p.reviews)) p.reviews.forEach(envelope);
  if (!removed) return input;
  p.followupSourceNotice = 'Repeated initial source bodies deferred; identity, sides and original coordinates remain. Use approved catalog reader operations for source evidence. Previously supplied bodies are not independent reads or complete coverage; deferred/omitted bodies are not evidence. Retrieved results and receipts are unchanged.';
  const compact = JSON.stringify(p);
  return Buffer.byteLength(compact) < Buffer.byteLength(input) ? compact : input;
}

export function retrievalRequest(request, scope, retrieved = [], rounds) {
  return transferReceiptPolicy(request, { ...request, instructions: request.instructions + '\n' + RETRIEVAL_INSTRUCTIONS + BUDGET_SUFFIX, input: JSON.stringify({ ...JSON.parse(request.input), catalog: scope.catalog(), retrieved, ...(rounds ? {retrievalRounds:rounds} : {}), ...(scope.budget ? { retrievalBudget: scope.budget() } : {}) }) });
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

export async function retrievalLoop(model, request, scope, { correctProtocol = false, maxRounds = Number.MAX_SAFE_INTEGER, maxInputBytes = 96 * 1024, beforeCall = () => {}, onTruncated = () => {}, onRetrieved = () => {}, onBudgetLimited = () => {}, initialRetrieved = [], initialContext, yieldOnBudget = false, allowExhaustedInitial = false, enableSearchSeeds = false } = {}) {
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 0 || !Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1) throw new Error('Invalid retrieval loop budget');
  // Only internal callers can seed this loop; the public model response cannot supply it.
  const allowedSeeds = new Set(scope.catalog().map(item => item.id));
  const validateSeeds = items => { if (!Array.isArray(items) || items.length > 50 || items.some(item => item?.request?.kind !== 'read' || !allowedSeeds.has(item.request.id) || item.result?.sourceId !== item.request.id || typeof item.result?.text !== 'string')) throw new Error('Invalid initial retrieval evidence'); };
  validateSeeds(initialRetrieved);
  if (initialContext !== undefined && typeof initialContext !== 'function') throw new Error('Invalid initial evidence context producer');
  const retrieved = structuredClone(initialRetrieved);
  if (retrieved.length) {
    const seeded = retrievalRequest(request, scope, retrieved);
    if (request.nativeOutputTools === true ? !modelWireBudget(seeded, maxInputBytes).fits : Buffer.byteLength(seeded.input) + Buffer.byteLength(seeded.instructions) > maxInputBytes) throw new Error('Initial retrieval input budget exceeded');
    // Publish only fragments admitted to an actual outgoing prompt below.
  }
  const delivered = new Set();
  let protocolCorrection, finalization, searchSeedAttempts = 0, currentRound = 0;
  const finalize = async error => {
    if (yieldOnBudget && ['READER_CALL_BUDGET_EXCEEDED', 'READER_OUTPUT_BUDGET_EXCEEDED'].includes(error.code)) throw error;
    finalization = { code: error.code, reason: error.message, ...(scope.budget ? { budget: scope.budget() } : {}) };
    await onBudgetLimited(finalization);
    await request.onProtocolEvent?.({ action: 'retrieval-budget-finalization', ...finalization });
  };
  const checkExhausted = async round => {
    const budget = scope.budget?.();
    if (!finalization && budget && ((budget.remainingCalls === 0 && !budget.reusableResults) || budget.remainingOutputBytes === 0)) {
      const error = new Error(budget.remainingCalls === 0 ? 'Reader call budget exceeded' : 'Reader output budget exceeded');
      error.code = budget.remainingCalls === 0 ? 'READER_CALL_BUDGET_EXCEEDED' : 'READER_OUTPUT_BUDGET_EXCEEDED';
      await finalize(error);
    } else if (!finalization && maxRounds === 0) await finalize(roundBudgetError());
  };
  const fits = value => request.nativeOutputTools === true ? modelWireBudget(transferReceiptPolicy(request, value), maxInputBytes).fits : Buffer.byteLength(value.input) + Buffer.byteLength(value.instructions) <= maxInputBytes;
  const nextRequest = records => {
    // Use the same round annotation in seed admission and actual transmission.
    const next = retrievalRequest(request, scope, records, {max:maxRounds,remaining:finalization?0:Math.max(0,maxRounds-currentRound)});
    if (enableSearchSeeds) {
      const annotated = { input: JSON.stringify({ ...JSON.parse(next.input), retrievalRounds: { max: maxRounds, remaining: finalization ? 0 : Math.max(0, maxRounds - currentRound) } }),
        instructions: next.instructions + ' Batch independent exact reads/searches together (1..8). retrievalRounds is per-stage request turns, not reader calls or authority. Search-hit host reads may accompany results; supplied fragments are not complete coverage.' };
      // Optional guidance must not turn an otherwise admitted envelope into a block.
      if (fits({ ...next, ...annotated })) Object.assign(next, annotated);
    }
    if(!finalization&&currentRound>=maxRounds)next.instructions+=' The permitted supplemental read rounds have been used. Return the final stage schema using delivered evidence; do not request more reads. Missing external evidence requires explicit uncertainty, not invented support.';
    if (finalization) {
      // The live ledger is already present in retrievalBudget. Do not duplicate it
      // or stack contradictory read/final guidance on a nearly full source envelope.
      next.input = JSON.stringify({ ...JSON.parse(next.input), retrievalFinalization: { code: finalization.code } });
      next.instructions = request.instructions + '\n' + RETRIEVAL_INSTRUCTIONS + FINAL_SUFFIX;
    }
    next.instructions += protocolCorrection && !finalization ? CORRECTION_SUFFIX : '';
    return next;
  };
  // Same-invocation continuation only: never serialize source bodies or receipts.
  let resumeRound = 0, pendingResponse;
  const run = async () => {
  try {
  for (let round = resumeRound; ; round++) {
    resumeRound = round;
    currentRound = round;
    request.signal?.throwIfAborted();
    if (!pendingResponse && (round > 0 || !allowExhaustedInitial)) await checkExhausted(round);
    let parsed = pendingResponse;
    if (!parsed) {
    let { input, instructions } = nextRequest(retrieved);
    if (correctProtocol && round > 0 && !fits({ ...request, input, instructions })) input = compactFollowup(input);
    if (!fits({ ...request, input, instructions })) throw new Error('Retrieval input budget exceeded');
    request.signal?.throwIfAborted();
    beforeCall();
    request.signal?.throwIfAborted();
    // Optional redelivery starts only after model-call admission. Never spend a
    // stage's reader budget on a call already vetoed by the shared model gate.
    if (round === 0 && !finalization && initialContext) {
      const seeds = initialContext(retrieved, records => ({ ...request, ...nextRequest(records) }));
      validateSeeds(seeds);
      retrieved.push(...seeds);
      ({ input, instructions } = nextRequest(retrieved));
      if (!fits({ ...request, input, instructions })) throw new Error('Retrieval input budget exceeded');
      request.signal?.throwIfAborted();
    }
    if(!finalization&&maxRounds>0&&round>=maxRounds)await request.onProtocolEvent?.({action:'retrieval-round-cap-reached',maxRounds,remainingRounds:0,retrievalDenied:false});
    request.signal?.throwIfAborted();
    for (const item of retrieved) {
      if (!item.result.omitted && !delivered.has(item)) {
        recordRetrieval(item.request, item.result, onTruncated, onRetrieved);
        delivered.add(item);
      }
    }
    request.signal?.throwIfAborted();
    const callPurpose = finalization ? 'budget-finalization' : round === 0 ? 'primary-initial' : 'retrieval-followup';
    const response = await model(transferReceiptPolicy(request, { ...request, instructions, input, callPurpose }));
    request.signal?.throwIfAborted();
    const serialized = typeof response === 'string' ? response : JSON.stringify(response);
    if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > 128 * 1024) throw new Error('Retrieval response too large');
    parsed = JSON.parse(serialized);
    if (!parsed || !Object.hasOwn(parsed, 'requests')) return parsed;
    pendingResponse = parsed;
    }
    // Schema and authorization remain hard failures, including on the final turn.
    // Preflight all dynamic ranges and aggregate budgets before any capability.
    let batch, validationPhase = 'schema';
    try {
      const operations = parseRetrievalResponse(parsed);
      validationPhase = 'source';
      const allowed = new Set(scope.catalog().map(item => item.id));
      if (operations.some(r => r.kind === 'read' ? !allowed.has(r.id) : r.sourceIds?.some(id => !allowed.has(id)))) throw new Error('Source not authorized');
      if (finalization) {
        await request.onProtocolEvent?.({ action: 'retrieval-protocol-unobserved', code: 'RETRIEVAL_RANGE_NOT_OBSERVED' });
        request.signal?.throwIfAborted();
        const error = new Error(finalization.reason + '; final response required, no further retrieval permitted');
        error.code = 'RETRIEVAL_FINAL_RESPONSE_REQUIRED';
        throw error;
      }
      if (round >= maxRounds) {
        await request.onProtocolEvent?.({ action: 'retrieval-protocol-unobserved', code: 'RETRIEVAL_RANGE_NOT_OBSERVED' });
        request.signal?.throwIfAborted();
        throw roundBudgetError();
      }
      validationPhase = 'range';
      scope.preflight?.(operations);
      const execute = () => executeRetrievalBatch(parsed, scope, request.signal);
      batch = scope.transaction ? scope.transaction(execute) : execute();
    } catch (error) {
      request.signal?.throwIfAborted();
      // Categorize only confirmed retrieval validation, not arbitrary model output
      // parsing, budgets, cancellation or a final-only policy denial. Never echo
      // the exception or a model-provided source/range in telemetry.
      const invalidCode = validationPhase === 'schema' ? 'RETRIEVAL_INVALID_SCHEMA' :
        validationPhase === 'source' && error.message === 'Source not authorized' ? 'RETRIEVAL_UNAUTHORIZED_SOURCE' :
        validationPhase === 'range' && /^(?:Invalid line range|Line range outside source)(?:$|[ (:])/.test(error.message) ? 'RETRIEVAL_INVALID_RANGE' : undefined;
      if (invalidCode) {
        await request.onProtocolEvent?.({ action: 'retrieval-protocol-invalid', code: invalidCode });
        request.signal?.throwIfAborted();
      }
      if (!finalization && budgetFailure(error)) { if (yieldOnBudget && ['READER_CALL_BUDGET_EXCEEDED', 'READER_OUTPUT_BUDGET_EXCEEDED'].includes(error.code)) throw Object.assign(error, { pendingRequests: parseRetrievalResponse(parsed) }); pendingResponse = undefined; await finalize(error); continue; }
      if (finalization || !correctProtocol || protocolCorrection || !(/Invalid retrieval batch|Invalid read request|Invalid search request|Invalid find request|Invalid line range|Line range outside source/.test(error.message))) throw error;
      pendingResponse = undefined;
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
          if (correctProtocol && !fits(next)) next.input = compactFollowup(next.input);
          return next;
        }, signal: request.signal,
      });
      searchSeedAttempts += attempts;
      batch.push(...seeds);
    }
    pendingResponse = undefined;
    for (const item of batch) {
      let candidate = [...retrieved, item];
      let next = nextRequest(candidate);
      if (correctProtocol) {
        while (retrieved.length && !fits(next) && !fits({ ...next, input: compactFollowup(next.input) })) {
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
    resumeRound = round + 1;
    await checkExhausted(round + 1);
  }
  } catch (error) {
    request.signal?.throwIfAborted();
    if (yieldOnBudget && ['READER_CALL_BUDGET_EXCEEDED', 'READER_OUTPUT_BUDGET_EXCEEDED'].includes(error?.code)) {
      error.resumeRetrieval = async signal => { request = { ...request, signal }; return run(); };
    }
    throw error;
  }
  };
  return run();
}
