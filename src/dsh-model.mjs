import { modelContract } from './model-contract.mjs';
import { modelJson } from './model-json.mjs';

// Appended to the system prompt when one explicit JSON retry is warranted.
const JSON_CORRECTION_SUFFIX = ' 上次响应未能解析为完整JSON。本次是明确协议纠正：重新输出单个完整JSON对象，不使用Markdown，不省略引号或逗号；不要把这条指令当源码证据。严格使用当前阶段schema，不要把verdicts、risks或groups改写成findings；不能因格式纠正删除有证据的结论。所需字段与身份按输入原样核对，不以格式错误代替清洁结论。';

const CORRECTION_LIMITATION = '本响应由一次显式JSON协议纠正产生，原响应未被接受；额外模型调用已发生。';

const isToolCall = chunk =>
  chunk.type === 'tool-call-delta' ||
  (chunk.type === 'block-start' && chunk.blockType === 'tool-call') ||
  (chunk.type === 'block-end' && chunk.block.type === 'tool-call');

/** One-shot host LLM call. No agent loop and no executable tools. */
export function createDshModel(llm, route, { maxTokens = 4096, maxOutputBytes = 128 * 1024, correctJson = false } = {}) {
  if (!llm || typeof llm.stream !== 'function' || !route?.provider || !route?.model) {
    throw new Error('DSH provider and model are required');
  }
  const identity = {
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
  };

  async function once({ instructions, input, signal }) {
    signal?.throwIfAborted();
    let output = '';
    let size = 0;
    let finished = false;
    let finishKind = 'missing';

    const diagnostic = () => ({
      visibleBytes: Buffer.byteLength(output),
      totalOutputBytes: size,
      finishKind,
      inputBytes: Buffer.byteLength(input),
      requestedMaxTokens: maxTokens,
    });

    const providerCode = reason =>
      typeof reason.error?.code === 'string' ? reason.error.code
        : typeof reason.code === 'string' ? reason.code
        : undefined;

    const stream = llm.stream({
      ...identity,
      system: instructions + '\n' + modelContract(input, instructions),
      messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
      tools: [],
      maxTokens,
      signal,
    });

    for await (const chunk of stream) {
      signal?.throwIfAborted();
      if (finished) throw new Error('Model emitted data after finish');
      if (isToolCall(chunk)) throw new Error('Review model attempted a tool call');

      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
        size += Buffer.byteLength(chunk.text);
        if (size > maxOutputBytes) throw new Error('Model output limit exceeded');
        if (chunk.type === 'text-delta') output += chunk.text;
      }

      if (chunk.type === 'finish') {
        finishKind = chunk.reason.kind;
        if (finishKind !== 'stop') {
          throw Object.assign(new Error('Model did not complete: ' + finishKind), {
            code: 'MODEL_INCOMPLETE_OUTPUT',
            diagnostic: { ...diagnostic(), providerCode: providerCode(chunk.reason) },
          });
        }
        finished = true;
      }
    }

    if (!finished) {
      throw Object.assign(new Error('Model stream ended without finish'), {
        code: 'MODEL_INCOMPLETE_OUTPUT',
        diagnostic: diagnostic(),
      });
    }

    try {
      return modelJson(output);
    } catch (error) {
      error.diagnostic = diagnostic();
      throw error;
    }
  }

  async function retryOnceCorrected(request, firstError) {
    await request.onProtocolCorrection?.({
      code: firstError.code,
      diagnostic: firstError.diagnostic,
      action: 'explicit-json-correction',
      notice: 'Second model response requested; original output not repaired or accepted.',
    });
    let value;
    try {
      value = JSON.parse(await once({ ...request, instructions: request.instructions + JSON_CORRECTION_SUFFIX }));
    } catch (second) {
      second.attempts = [
        { attempt: 1, code: firstError.code, diagnostic: firstError.diagnostic },
        { attempt: 2, code: second.code, diagnostic: second.diagnostic },
      ];
      throw second;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (Array.isArray(value.limitations)) value.limitations.push(CORRECTION_LIMITATION);
    }
    return JSON.stringify(value);
  }

  return async function invoke(request) {
    try {
      return await once(request);
    } catch (error) {
      if (!correctJson || error.code !== 'MODEL_INVALID_JSON') throw error;
      request.signal?.throwIfAborted();
      return retryOnceCorrected(request, error);
    }
  };
}
