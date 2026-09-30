/** One-shot host LLM call. No agent loop and no executable tools. */
export function createDshModel(llm, route, { maxTokens = 4096, maxOutputBytes = 128 * 1024 } = {}) {
  if (!llm || typeof llm.stream !== 'function' || !route?.provider || !route?.model) throw new Error('DSH provider and model are required');
  const identity = { provider: route.provider, model: route.model, ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}) };
  return async ({ instructions, input, signal }) => {
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
    return output;
  };
}
