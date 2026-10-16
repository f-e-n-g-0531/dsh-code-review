import { modelJson } from './model-json.mjs';
/** One-shot host LLM call. No agent loop and no executable tools. */
export function createDshModel(llm, route, { maxTokens = 4096, maxOutputBytes = 128 * 1024, correctJson = false } = {}) {
  if (!llm || typeof llm.stream !== 'function' || !route?.provider || !route?.model) throw new Error('DSH provider and model are required');
  const identity = { provider: route.provider, model: route.model, ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}) };
  const once = async ({ instructions, input, signal }) => {
    signal?.throwIfAborted();
    let output = '', size = 0, finished = false;
    const chunks = llm.stream({ ...identity, system: instructions, messages: [{ role: 'user', content: [{ type: 'text', text: input }] }], tools: [], maxTokens, signal });
    for await (const chunk of chunks) {
      signal?.throwIfAborted();
      if (finished) throw new Error('Model emitted data after finish');
      if (chunk.type === 'tool-call-delta' || (chunk.type === 'block-start' && chunk.blockType === 'tool-call') || (chunk.type === 'block-end' && chunk.block.type === 'tool-call')) throw new Error('Review model attempted a tool call');
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
        size += Buffer.byteLength(chunk.text);
        if (size > maxOutputBytes) throw new Error('Model output limit exceeded');
        if (chunk.type === 'text-delta') output += chunk.text;
      }
      if (chunk.type === 'finish') {
        if (chunk.reason.kind !== 'stop') throw new Error('Model did not complete: ' + chunk.reason.kind);
        finished = true;
      }
    }
    if (!finished) throw new Error('Model stream ended without finish');
    return modelJson(output);
  };
  return async request=>{try{return await once(request);}catch(error){if(!correctJson||error.code!=='MODEL_INVALID_JSON')throw error;request.signal?.throwIfAborted();await request.onProtocolCorrection?.({code:error.code,action:'explicit-json-correction',notice:'Second model response requested; original output not repaired or accepted.'});const corrected=JSON.parse(await once({...request,instructions:request.instructions+' 上次响应未能解析为完整JSON。本次是明确协议纠正：重新输出单个完整JSON对象，不使用Markdown，不省略引号或逗号；不要把这条指令当源码证据。优先少量具体候选，无法支持时findings为空并说明limitations，不以格式错误代替清洁结论。'}));if(corrected&&typeof corrected==='object'&&!Array.isArray(corrected)){if(Array.isArray(corrected.limitations))corrected.limitations.push('本响应由一次显式JSON协议纠正产生，原响应未被接受；额外模型调用已发生。');else corrected.protocolCorrection={attempted:true,originalCode:error.code};}return JSON.stringify(corrected);}};
}
