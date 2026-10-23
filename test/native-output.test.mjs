import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDshModel } from '../src/dsh-model.mjs';
import { modelResultTools, modelResultStage, nativeResultWireBytes, RESULT_TOOL_NAME, NATIVE_RESULT_INSTRUCTIONS } from '../src/model-tools.mjs';
import { modelContract } from '../src/model-contract.mjs';
import { RISK_PLAN_INSTRUCTIONS, BUSINESS_GROUP_INSTRUCTIONS } from '../src/prompts.mjs';

const route = { provider: 'mock', model: 'offline' };
const result = '{"findings":[],"limitations":[]}';
const request = extra => ({ input: JSON.stringify({ file: { id: 'f' } }), instructions: 'Review approved sources.', ...extra });
const finish = kind => ({ type: 'finish', reason: { kind } });
const tool = (argumentsText = result, name = RESULT_TOOL_NAME, index = 0) => ({ type: 'block-end', index, block: { type: 'tool-call', id: 'call-id', name, arguments: argumentsText } });
function mock(chunks) { const calls = []; let closed = 0; return { calls, get closed() { return closed; }, llm: { stream(options) { calls.push(options); return (async function* () { try { for (const chunk of typeof chunks === 'function' ? chunks(calls.length) : chunks) yield chunk; } finally { closed++; } })(); } } }; }

test('native tool uses exact installed ToolSchema fields and returns JSON data without dispatch', async () => {
  const m = mock([{ type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: 'call-id', name: RESULT_TOOL_NAME, argumentsDelta: result.slice(0, 9) },
    { type: 'tool-call-delta', index: 0, id: 'call-id', argumentsDelta: result.slice(9) }, tool(), finish('tool-calls')]);
  const events = [], artifacts = [];
  const invoke = createDshModel(m.llm, route, { useNativeTools: true });
  assert.equal(await invoke(request({ onProtocolEvent: e => events.push(e), onModelArtifact: e => artifacts.push(e) })), result);
  assert.equal(m.calls.length, 1); assert.equal(m.calls[0].tools.length, 1);
  assert.deepEqual(Object.keys(m.calls[0].tools[0]).sort(), ['description', 'name', 'parameters']);
  assert.equal(m.calls[0].tools[0].name, RESULT_TOOL_NAME); assert.equal(m.calls[0].toolChoice, undefined);
  assert.equal(events[0].kind, 'native-tool'); assert.equal(artifacts[0].blocks[0].arguments, result);
  assert.equal(artifacts[0].sha256, createHash('sha256').update(JSON.stringify(artifacts[0].blocks)).digest('hex'));
  assert.equal(artifacts[0].status, 'completed'); assert.equal(artifacts[0].untrusted, true);
});

test('same-call text fallback and safe suffix recovery never create another provider send', async () => {
  for (const [text, kind] of [[result, 'text-compatible'], [result + '\nReview complete.', 'trailing-prose']]) {
    const m = mock([{ type: 'text-delta', index: 0, text }, finish('stop')]), events = [];
    assert.equal(await createDshModel(m.llm, route, { useNativeTools: true })(request({ onProtocolEvent: e => events.push(e) })), result);
    assert.equal(m.calls.length, 1); assert.equal(events[0].kind, kind);
  }
});

test('native schemas and contracts cover groups risks verdicts interactions group-primary and finalization', () => {
  for (const [payload, instructions, stage] of [
    [{ file: { id: 'f' } }, '', 'findings'], [{ sourceMode: 'file-interaction' }, '', 'findings'],
    [{ candidates: [] }, '', 'verdicts'], [{}, RISK_PLAN_INSTRUCTIONS, 'risks'], [{}, BUSINESS_GROUP_INSTRUCTIONS, 'groups'],
    [{ sourceMode: 'group-primary', files: [] }, '', 'reviews'],
  ]) {
    const input = JSON.stringify(payload), tools = modelResultTools(input, instructions);
    assert.equal(modelResultStage(input, instructions), stage); assert.equal(tools.length, 1);
    const final = tools[0].parameters.oneOf?.[0] ?? tools[0].parameters;
    assert.ok(final.properties[stage]);
    if (stage === 'reviews') assert.match(modelContract(input), /reviews/);
    const finalized = modelResultTools(JSON.stringify({ ...payload, retrievalFinalization: true }), instructions)[0];
    assert.equal(finalized.parameters.oneOf, undefined);
  }
});

test('native tool retrieval and grouped results remain stage-specific data for downstream validation', async () => {
  for (const [payload, args] of [[{ file: { id: 'f' } }, '{"requests":[{"kind":"read","id":"s1","start":1,"count":1}]}'],
    [{ sourceMode: 'group-primary', files: [] }, '{"reviews":[],"limitations":[]}']]) {
    const m = mock([tool(args), finish('tool-calls')]);
    assert.equal(await createDshModel(m.llm, route, { useNativeTools: true })(request({ input: JSON.stringify(payload) })), args);
  }
});

test('unknown multiple mixed tool identity and wrong-stage outputs reject without retries', async () => {
  for (const chunks of [[tool(result, 'write_file'), finish('tool-calls')], [tool(), tool(result, RESULT_TOOL_NAME, 1), finish('tool-calls')],
    [{ type: 'text-delta', index: 1, text: result }, tool(), finish('tool-calls')], [tool('{"risks":[]}'), finish('tool-calls')],
    [finish('tool-calls')], [tool(), finish('max-tokens')],
    [{ type: 'tool-call-delta', index: 0, id: 'a', name: RESULT_TOOL_NAME, argumentsDelta: '{' },
      { type: 'tool-call-delta', index: 0, id: 'b', argumentsDelta: '}' }, finish('tool-calls')],
  ]) {
    const m = mock(chunks), artifacts = [];
    await assert.rejects(createDshModel(m.llm, route, { useNativeTools: true, correctJson: true })(request({ onModelArtifact: e => artifacts.push(e) })), e => e.code !== 'MODEL_INVALID_JSON');
    assert.equal(m.calls.length, 1); assert.equal(m.closed, 1); assert.equal(artifacts.length, 1); assert.equal(artifacts[0].status, 'failed');
  }
});

test('artifact persistence is awaited before correction and never causes retries; reasoning excluded', async () => {
  const m = mock(n => [{ type: 'reasoning-delta', index: 1, text: 'PRIVATE REASONING' }, { type: 'text-delta', index: 0, text: n === 1 ? '{bad' : result }, finish('stop')]);
  const records = [];
  await createDshModel(m.llm, route, { correctJson: true })(request({ onModelArtifact: async a => { records.push(a); assert.equal(m.calls.length, records.length); } }));
  assert.equal(records.length, 2); assert.equal(records[0].status, 'failed'); assert.equal(records[1].status, 'completed');
  assert.ok(!JSON.stringify(records).includes('PRIVATE REASONING'));
  const bad = mock([{ type: 'text-delta', index: 0, text: '{bad' }, finish('stop')]);
  await assert.rejects(createDshModel(bad.llm, route, { correctJson: true })(request({ onModelArtifact() { throw new Error('disk SECRET'); } })), e => e.code === 'MODEL_ARTIFACT_FAILED' && !e.message.includes('SECRET'));
  assert.equal(bad.calls.length, 1);
});

test('artifact persistence failure cannot override active cancellation authority',async()=>{const controller=new AbortController(),reason=new Error('cancel-authority');const m={stream:async function*(){try{yield {type:'text-delta',index:0,text:result};}finally{controller.abort(reason);}}};await assert.rejects(createDshModel(m,route)(request({signal:controller.signal,onModelArtifact(){throw new Error('disk');}})),error=>error===reason);});

test('native JSON correction keeps tools same approved input and captures rejected arguments first', async () => {
  const m = mock(n => [tool(n === 1 ? '{bad' : result), finish('tool-calls')]);
  const records = [], corrections = [];
  const output = await createDshModel(m.llm, route, { useNativeTools: true, correctJson: true })(request({
    onModelArtifact: a => records.push(a), onProtocolCorrection: e => { assert.equal(records.length, 1); corrections.push(e); },
  }));
  assert.equal(output, result); assert.equal(m.calls.length, 2); assert.equal(corrections.length, 1);
  assert.deepEqual(m.calls[0].tools, m.calls[1].tools); assert.deepEqual(m.calls[0].messages, m.calls[1].messages);
  assert.equal(records[0].blocks[0].arguments, '{bad'); assert.equal(records[0].status, 'failed');
  const strict = mock([tool(result + '\nProse'), finish('tool-calls')]);
  await assert.rejects(createDshModel(strict.llm, route, { useNativeTools: true })(request()), e => e.code === 'MODEL_INVALID_JSON');
  const closed = mock([tool(), { type: 'tool-call-delta', index: 0, id: 'call-id', name: RESULT_TOOL_NAME, argumentsDelta: 'extra ignored' }, finish('tool-calls')]);
  assert.equal(await createDshModel(closed.llm, route, { useNativeTools: true })(request()), result);
});

test('native wire guard accounts tool schema and preference before first send at exact boundary', async () => {
  const req = request(), tools = modelResultTools(req.input, req.instructions);
  const bytes = Buffer.byteLength(req.input) + Buffer.byteLength(req.instructions + '\n' + modelContract(req.input, req.instructions)) + nativeResultWireBytes(req.input, req.instructions);
  assert.equal(nativeResultWireBytes(req.input, req.instructions), Buffer.byteLength(JSON.stringify(tools)) + Buffer.byteLength(NATIVE_RESULT_INSTRUCTIONS));
  const m = mock([tool(), finish('tool-calls')]);
  const invoke = createDshModel(m.llm, route, { useNativeTools: true });
  await assert.rejects(invoke({ ...req, maxInputBytes: bytes - 1 }), e => e.code === 'MODEL_INPUT_BUDGET_EXCEEDED');
  assert.equal(m.calls.length, 0);
  assert.equal(await invoke({ ...req, maxInputBytes: bytes }), result); assert.equal(m.calls.length, 1);
});

test('private artifacts capture rejected oversized output with a bounded exact prefix', async () => {
  const records = [], text = '😀\u0000'.repeat(200000);
  const m = mock([{ type: 'text-delta', index: 0, text }, finish('stop')]);
  await assert.rejects(createDshModel(m.llm, route, { maxOutputBytes: 100 })(request({ onModelArtifact: a => records.push(a) })), e => e.code === 'MODEL_OUTPUT_LIMIT');
  assert.equal(records.length, 1); assert.equal(records[0].status, 'failed'); assert.equal(records[0].truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(records[0])) < 1024 * 1024);
  assert.ok(text.startsWith(records[0].blocks[0].text));
  assert.ok(!records[0].blocks[0].text.includes('�'));
});

test('native output limits cancelled cleanup and per-request legacy override remain bounded', async () => {
  const oversized = mock([tool(result.repeat(10)), finish('tool-calls')]);
  await assert.rejects(createDshModel(oversized.llm, route, { useNativeTools: true, maxOutputBytes: 20 })(request()), e => e.code === 'MODEL_OUTPUT_LIMIT');
  const controller = new AbortController(), artifacts = [], events = [];
  const cancelled = mock([{ type: 'tool-call-delta', index: 0, id: 'call', name: RESULT_TOOL_NAME, argumentsDelta: '{' }, finish('tool-calls')]);
  await assert.rejects(createDshModel(cancelled.llm, route, { useNativeTools: true })(request({ signal: controller.signal, onModelEvent: e => { events.push(e); if (e.action === 'model-start') controller.abort(); }, onModelArtifact: e => artifacts.push(e) })));
  assert.equal(artifacts[0].status, 'cancelled'); assert.equal(events.at(-1).status, 'cancelled');
  const legacy = mock([{ type: 'text-delta', index: 0, text: result }, finish('stop')]);
  assert.equal(await createDshModel(legacy.llm, route, { useNativeTools: true })(request({ nativeOutputTools: false })), result);
  assert.deepEqual(legacy.calls[0].tools, []);
});
