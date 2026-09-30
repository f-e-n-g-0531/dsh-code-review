import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshModel } from '../src/dsh-model.mjs';
const request = { instructions: 'review', input: '{}', signal: new AbortController().signal };
const route = { provider: 'test', model: 'test-model' };
test('DSH bridge sends isolated messages and no tools', async () => {
  const llm = { async *stream(options) {
    assert.deepEqual(options.tools, []); assert.equal(options.messages.length, 1); assert.equal(options.signal, request.signal);
    assert.equal(options.provider, 'test'); assert.equal(options.maxTokens, 4096);
    yield { type: 'text-delta', index: 0, text: '{"findings":[],"limitations":[]}' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } };
  const model = createDshModel(llm, route);
  assert.equal(JSON.parse(await model(request)).findings.length, 0);
});
test('DSH bridge refuses tool execution, truncated and incomplete responses', async () => {
  for (const chunk of [{ type: 'tool-call-delta' }, { type: 'finish', reason: { kind: 'max-tokens' } }, { type: 'text-delta', text: '{}' }]) {
    const model = createDshModel({ async *stream() { yield chunk; } }, route);
    await assert.rejects(model(request));
  }
});
test('DSH bridge bounds reasoning as well as visible output', async () => {
  const model = createDshModel({ async *stream() { yield { type: 'reasoning-delta', text: '12345' }; } }, route, { maxOutputBytes: 4 });
  await assert.rejects(model(request), /limit/);
});
