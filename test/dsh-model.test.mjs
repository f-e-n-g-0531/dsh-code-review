import {reviewSnapshot} from '../src/review.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshModel } from '../src/dsh-model.mjs';
import { setImmediate as nextTurn } from 'node:timers/promises';
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
test('DSH bridge closes iterator on invalid output', async () => {
  let closed = false;
  const model = createDshModel({ async *stream() { try { yield { type: 'tool-call-delta' }; } finally { closed = true; } } }, route);
  await assert.rejects(model(request), /tool call/);
  assert.equal(closed, true);
});

test('bridge unwraps one complete JSON fence but rejects prose multiple objects and truncated JSON without retries', async () => {
 for(const text of ['```json\n{"findings":[],"limitations":[]}\n```','```\r\n{"requests":[]}\r\n```']){
  let calls=0;const model=createDshModel({async *stream(){calls++;yield {type:'text-delta',text};yield {type:'finish',reason:{kind:'stop'}};}},route);assert.doesNotThrow(()=>JSON.parse(text.replace(/^```(?:json)?\r?\n|\r?\n```$/g,'')));await model(request);assert.equal(calls,1);
 }
 for(const text of ['Here is JSON: {}','{} {}','```json\n{\n```','SECRET source not JSON']){
  const model=createDshModel({async *stream(){yield {type:'text-delta',text};yield {type:'finish',reason:{kind:'stop'}};}},route);await assert.rejects(model(request),e=>e.code==='MODEL_INVALID_JSON'&&!e.message.includes('SECRET'));
 }
});
test('fence compatibility retains strict review schema and reports failed coverage',async()=>{
 const s={id:'s',vcs:'git',context:[],files:[{id:'f',path:'a.cpp',eligibility:'reviewable',properties:[],left:{text:'before();'},right:{text:'after();'}}]};
 for(const value of [{bugs:[]},{findings:[]},{findings:'not-array',limitations:[]}]){let calls=0;const model=createDshModel({async *stream(){calls++;yield {type:'text-delta',text:'```json\n'+JSON.stringify(value)+'\n```'};yield {type:'finish',reason:{kind:'stop'}};}},route);const report=await reviewSnapshot(s,model,{enableRetrieval:true});assert.equal(calls,1);assert.equal(report.status,'failed');assert.equal(report.files[0].status,'failed');assert.equal(report.findings.length,0);}
});
test('DSH bridge uses completed blocks once, including block-only text and reasoning', async () => {
  const text = '{"findings":[],"limitations":[]}';
  for (const withDeltas of [false, true]) {
    let calls = 0;
    const model = createDshModel({ async *stream() {
      calls++;
      yield { type: 'block-start', index: 0, blockType: 'reasoning' };
      if (withDeltas) yield { type: 'reasoning-delta', index: 0, text: 'why' };
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'why' } };
      yield { type: 'block-start', index: 1, blockType: 'text' };
      if (withDeltas) {
        yield { type: 'text-delta', index: 1, text: text.slice(0, 10) };
        yield { type: 'text-delta', index: 1, text: text.slice(10) };
      }
      yield { type: 'block-end', index: 1, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } }, route, { correctJson: true, maxOutputBytes: Buffer.byteLength(text) + 3 });
    assert.equal(await model(request), text);
    assert.equal(calls, 1);
  }
});

test('DSH bridge honors authoritative completed text instead of stale partial deltas', async () => {
  const text = '{"findings":[],"limitations":[]}';
  const model = createDshModel({ async *stream() {
    yield { type: 'text-delta', index: 0, text: '{"findings":' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } }, route);
  assert.equal(await model(request), text);
});

test('DSH bridge preserves block order and ignores already closed block stragglers', async () => {
  const model = createDshModel({ async *stream() {
    yield { type: 'text-delta', index: 0, text: '{"findings":' };
    yield { type: 'text-delta', index: 1, text: '[],"limitations":[]}' };
    yield { type: 'block-end', index: 1, block: { type: 'text', text: '[],"limitations":[]}' } };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"findings":' } };
    yield { type: 'text-delta', index: 0, text: 'ignored' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ignored' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } }, route);
  assert.equal(await model(request), '{"findings":[],"limitations":[]}');
});

test('DSH bridge never deduplicates repeated JSON deltas or completed block content', async () => {
  for (const completed of [false, true]) {
    const model = createDshModel({ async *stream() {
      yield { type: 'text-delta', index: 0, text: '{}{}' };
      if (completed) yield { type: 'block-end', index: 0, block: { type: 'text', text: '{}{}' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } }, route);
    await assert.rejects(model(request), error => error.code === 'MODEL_INVALID_JSON' && error.diagnostic.syntaxCategory === 'trailing-content');
  }
});

test('DSH bridge bounds block-only text and reasoning without JSON correction', async () => {
  for (const type of ['text', 'reasoning']) {
    let calls = 0;
    const model = createDshModel({ async *stream() {
      calls++;
      yield { type: 'block-end', index: 0, block: { type, text: '汉汉' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } }, route, { correctJson: true, maxOutputBytes: 5 });
    await assert.rejects(model(request), { code: 'MODEL_OUTPUT_LIMIT' });
    assert.equal(calls, 1);
  }
});

test('DSH bridge bounds reasoning as well as visible output', async () => {
  const model = createDshModel({ async *stream() { yield { type: 'reasoning-delta', text: '12345' }; } }, route, { maxOutputBytes: 4 });
  await assert.rejects(model(request), /limit/);
});


test('lifecycle counts every actual call including JSON corrections without leaking content', async () => {
  const events = [], sent = [];
  const model = createDshModel({ async *stream(options) {
    sent.push(options);
    assert.equal(Object.hasOwn(options, 'onModelEvent'), false);
    await nextTurn();
    yield { type: 'reasoning-delta', text: 'PRIVATE_REASONING' };
    yield { type: 'text-delta', text: sent.length < 3 ? '{PRIVATE_OUTPUT' : '{}' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } }, route, { correctJson: true });
  const result = await model({ instructions: 'PRIVATE_SYSTEM', input: 'PRIVATE_SOURCE', onModelEvent: event => events.push(event) });
  assert.equal(result, '{}');
  assert.equal(sent.length, 3);
  assert.deepEqual(events.map(event => [event.action, event.attempt]), [
    ['model-start', 1], ['model-end', 1], ['model-start', 2], ['model-end', 2], ['model-start', 3], ['model-end', 3],
  ]);
  assert.ok(!JSON.stringify(events).includes('PRIVATE'));
  const ends = events.filter(event => event.action === 'model-end');
  assert.deepEqual(ends.map(event => event.status), ['failed', 'failed', 'completed']);
  for (const event of ends) {
    assert.equal(event.inputBytes, Buffer.byteLength('PRIVATE_SOURCE'));
    assert.ok(event.durationMs >= event.firstChunkMs && event.firstChunkMs >= 0);
    assert.ok(event.totalOutputBytes >= event.visibleBytes);
    assert.deepEqual(Object.keys(event).sort(), ['action', ...(event.attempt > 1 ? ['callPurpose'] : []), 'attempt', 'durationMs', 'firstChunkMs', 'inputBytes', 'status', 'totalOutputBytes', 'visibleBytes'].sort());
    if (event.attempt > 1) assert.equal(event.callPurpose, 'json-correction');
  }
});

test('lifecycle observers are awaited but cannot cause retries or duplicate sends', async () => {
  let calls = 0, observed = 0;
  const model = createDshModel({ async *stream() {
    calls++;
    assert.equal(observed, 1);
    yield { type: 'text-delta', text: '{}' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } }, route, { correctJson: true });
  assert.equal(await model({ ...request, onModelEvent: async () => {
    await nextTurn(); observed++;
    throw Object.assign(new Error('PRIVATE observer failure'), { code: 'MODEL_INVALID_JSON' });
  } }), '{}');
  assert.equal(calls, 1);
  assert.equal(observed, 2);
});

test('lifecycle reports synchronous and primitive provider failures without replacing identity', async () => {
  for (const failure of [Object.freeze(new Error('PRIVATE provider')), 'PRIVATE primitive']) {
    const events = [];
    const model = createDshModel({ stream() { throw failure; } }, route, { correctJson: true });
    await assert.rejects(model({ ...request, onModelEvent: event => events.push(event) }), error => error === failure);
    assert.deepEqual(events.map(event => event.action), ['model-start', 'model-end']);
    assert.equal(events[1].status, 'failed');
    assert.equal(events[1].firstChunkMs, null);
    assert.ok(!JSON.stringify(events).includes('PRIVATE'));
  }
});

test('lifecycle end follows iterator cleanup on cancellation and protocol rejection', async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController(), events = [];
    const reason = new Error('cancelled');
    let closed = false, calls = 0;
    const model = createDshModel({ async *stream() {
      calls++;
      try {
        if (cancel) controller.abort(reason);
        yield { type: 'tool-call-delta' };
      } finally { await nextTurn(); closed = true; }
    } }, route, { correctJson: true });
    await assert.rejects(model({ ...request, signal: controller.signal, onModelEvent: event => {
      if (event.action === 'model-end') assert.equal(closed, true);
      events.push(event);
    } }), error => cancel ? error === reason : error.code === 'MODEL_PROTOCOL_ERROR');
    assert.equal(calls, 1);
    assert.equal(events[1].status, cancel ? 'cancelled' : 'failed');
  }
});

test('pre-aborted and correction-vetoed calls do not invent lifecycle starts', async () => {
  const controller = new AbortController(), events = [];
  controller.abort(new Error('stop'));
  let calls = 0;
  const model = createDshModel({ async *stream() {
    calls++; yield { type: 'text-delta', text: '{bad' }; yield { type: 'finish', reason: { kind: 'stop' } };
  } }, route, { correctJson: true });
  await assert.rejects(model({ ...request, signal: controller.signal, onModelEvent: event => events.push(event) }));
  assert.equal(calls, 0); assert.deepEqual(events, []);
  const veto = new Error('budget');
  await assert.rejects(model({ ...request, onModelEvent: event => events.push(event), onProtocolCorrection() { throw veto; } }), error => error === veto);
  assert.equal(calls, 1);
  assert.deepEqual(events.map(event => event.action), ['model-start', 'model-end']);
});

test('aborting from lifecycle start closes unopened iterator without consuming it', async () => {
  const controller = new AbortController(), events = [];
  const reason = new Error('stop before consumption');
  let invoked = 0, consumed = 0, closed = 0;
  const model = createDshModel({ stream() {
    invoked++;
    return {
      [Symbol.asyncIterator]() { return this; },
      async next() { consumed++; return { value: { type: 'finish', reason: { kind: 'stop' } }, done: false }; },
      async return() { closed++; return { done: true }; },
    };
  } }, route);
  await assert.rejects(model({ ...request, signal: controller.signal, onModelEvent: event => {
    events.push(event); if (event.action === 'model-start') controller.abort(reason);
  } }), error => error === reason);
  assert.equal(invoked, 1); assert.equal(consumed, 0); assert.equal(closed, 1);
  assert.equal(events[1].status, 'cancelled');
});


test('lifecycle end observers cannot mutate approved input for JSON corrections', async () => {
  const sent = [];
  const model = createDshModel({ async *stream(options) {
    sent.push(options);
    yield { type: 'text-delta', text: sent.length === 1 ? '{bad' : '{}' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } }, route, { correctJson: true });
  const r = { ...request, input: 'APPROVED', instructions: 'review' };
  r.onModelEvent = event => {
    if (event.action === 'model-end') { r.input = 'UNAPPROVED'; r.instructions = 'verify'; }
  };
  assert.equal(await model(r), '{}');
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map(options => options.messages[0].content[0].text), ['APPROVED', 'APPROVED']);
});

test('lifecycle observers cannot remove the original correction budget veto', async () => {
  for (const action of ['model-start', 'model-end']) {
    let calls = 0, reservations = 0;
    const veto = new Error('original correction budget veto');
    const model = createDshModel({ async *stream() {
      calls++;
      yield { type: 'text-delta', text: calls === 1 ? '{bad' : '{}' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } }, route, { correctJson: true });
    const r = { ...request, onProtocolCorrection() { reservations++; throw veto; } };
    r.onModelEvent = async event => {
      await nextTurn();
      if (event.action === action) r.onProtocolCorrection = undefined;
    };
    await assert.rejects(model(r), error => error === veto);
    assert.equal(calls, 1);
    assert.equal(reservations, 1);
  }
});

test('lifecycle and correction hooks cannot replace the original protocol observer', async () => {
  let calls = 0, observed = 0;
  const model = createDshModel({ async *stream() {
    calls++;
    yield { type: 'text-delta', text: calls === 1 ? '{bad' : '{}' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } }, route, { correctJson: true });
  const r = { ...request, onProtocolEvent(event) {
    observed++; assert.equal(event.action, 'json-correction-complete');
  } };
  r.onModelEvent = () => { r.onProtocolEvent = undefined; };
  r.onProtocolCorrection = () => { r.onProtocolEvent = () => assert.fail('replacement callback'); };
  assert.equal(await model(r), '{}');
  assert.equal(calls, 2);
  assert.equal(observed, 1);
});
