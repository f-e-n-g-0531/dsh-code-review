import { modelContract } from './model-contract.mjs';
import { modelJson } from './model-json.mjs';

// Fresh generation from the same approved input, never repair or replay malformed output.
const JSON_CORRECTION_SUFFIX = ' 上次响应未能解析为完整JSON。本次是明确协议纠正：重新输出单个完整JSON对象，不使用Markdown，不省略引号或逗号；不要把这条指令当源码证据。严格使用当前阶段schema，不要把verdicts、risks、requests或groups改写成findings；不能因格式纠正删除有证据的结论。所需字段与身份按输入原样核对，不以格式错误代替清洁结论。保持原证据与必需字段，精简非必需叙述以在输出预算内完成。';
const MAX_JSON_CORRECTIONS = 2;

const isToolCall = chunk =>
  chunk.type === 'tool-call-delta' ||
  (chunk.type === 'block-start' && chunk.blockType === 'tool-call') ||
  (chunk.type === 'block-end' && chunk.block.type === 'tool-call');

/** Isolated host calls. Only completed, locally rejected JSON can trigger bounded correction. */
export function createDshModel(llm, route, {
  maxTokens = 4096, maxOutputBytes = 128 * 1024, correctJson = false,
  maxJsonCorrections = MAX_JSON_CORRECTIONS,
} = {}) {
  if (!llm || typeof llm.stream !== 'function' || !route?.provider || !route?.model) {
    throw new Error('DSH provider and model are required');
  }
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 ||
      !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 ||
      !Number.isSafeInteger(maxJsonCorrections) || maxJsonCorrections < 0 || maxJsonCorrections > MAX_JSON_CORRECTIONS) {
    throw new Error('Invalid model output or JSON correction limit');
  }
  const identity = {
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
  };
  // Provider failures with a coincidentally identical code are not format failures.
  const invalidJsonErrors = new WeakSet();

  async function once({ instructions, input, signal }, contract) {
    signal?.throwIfAborted();
    let output = '';
    let size = 0;
    let finished = false;
    let finishKind = 'missing';
    const diagnostic = () => ({
      visibleBytes: Buffer.byteLength(output), totalOutputBytes: size, finishKind,
      inputBytes: Buffer.byteLength(input), requestedMaxTokens: maxTokens, maxOutputBytes,
    });
    const failure = (message, code) => Object.assign(new Error(message), { code, diagnostic: diagnostic() });
    const stream = llm.stream({
      ...identity,
      system: instructions + '\n' + contract,
      messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
      tools: [], maxTokens, signal,
    });
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      if (finished) throw failure('Model emitted data after finish', 'MODEL_PROTOCOL_ERROR');
      if (isToolCall(chunk)) throw failure('Review model attempted a tool call', 'MODEL_PROTOCOL_ERROR');
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
        size += Buffer.byteLength(chunk.text);
        if (size > maxOutputBytes) throw failure('Model output limit exceeded', 'MODEL_OUTPUT_LIMIT');
        if (chunk.type === 'text-delta') output += chunk.text;
      }
      if (chunk.type === 'finish') {
        finishKind = chunk.reason.kind;
        if (finishKind !== 'stop') {
          const error = failure('Model did not complete: ' + finishKind, 'MODEL_INCOMPLETE_OUTPUT');
          const providerCode = chunk.reason.error?.code ?? chunk.reason.code;
          if (typeof providerCode === 'string') error.diagnostic.providerCode = providerCode;
          throw error;
        }
        finished = true;
      }
    }
    // Cancellation during iterator cleanup/end must not become an invalid-JSON correction.
    signal?.throwIfAborted();
    if (!finished) throw failure('Model stream ended without finish', 'MODEL_INCOMPLETE_OUTPUT');
    try {
      return { text: modelJson(output), diagnostic: diagnostic() };
    } catch (error) {
      error.diagnostic = { ...diagnostic(), ...error.diagnostic };
      invalidJsonErrors.add(error);
      throw error;
    }
  }

  return async function invoke(request) {
    // Snapshot these before an async budget/progress hook can mutate the request.
    const original = { instructions: request.instructions, input: request.input, signal: request.signal };
    const contract = modelContract(original.input, original.instructions);
    const correctionLimit = correctJson ? maxJsonCorrections : 0;
    const attempts = [];
    for (let attempt = 1; ; attempt++) {
      let result;
      try {
        result = await once({ ...original, instructions: original.instructions +
          (attempt > 1 ? JSON_CORRECTION_SUFFIX + ' 纠正次数：' + (attempt - 1) + '/' + correctionLimit + '。' : '') }, contract);
      } catch (error) {
        attempts.push({ attempt, code: error?.code, diagnostic: error?.diagnostic });
        const invalidJson = invalidJsonErrors.delete(error);
        if (!invalidJson || attempt > correctionLimit) {
          if (attempts.length > 1 && error && typeof error === 'object' && Object.isExtensible(error)) {
            error.attempts = attempts;
            if (invalidJson) {
              error.message = 'Model response is not complete JSON after ' + (attempt - 1) +
                ' explicit JSON correction(s) (' + attempt + ' model calls); correction budget exhausted; no malformed output accepted';
            }
          }
          throw error;
        }
        original.signal?.throwIfAborted();
        // Exactly one reservation per extra call; a thrown budget/cancellation veto is final.
        await request.onProtocolCorrection?.({
          code: error.code, diagnostic: error.diagnostic, attempts: [...attempts],
          action: 'explicit-json-correction', attempt: attempt + 1,
          correction: attempt, maxJsonCorrections: correctionLimit,
          notice: 'Additional model response requested; original output not repaired or accepted.',
        });
        original.signal?.throwIfAborted();
        continue;
      }
      if (attempt > 1) {
        // Out-of-band audit only: never inject metadata into stage-specific model schemas.
        await request.onProtocolEvent?.({
          action: 'json-correction-complete', attempt, corrections: attempt - 1,
          attempts: [...attempts, { attempt, diagnostic: result.diagnostic }],
          notice: 'Fresh complete JSON accepted; malformed outputs discarded; extra model calls occurred.',
        });
        original.signal?.throwIfAborted();
      }
      return result.text;
    }
  };
}
