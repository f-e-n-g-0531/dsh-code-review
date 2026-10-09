import {reviewSnapshot} from '../src/review.mjs';
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
test('DSH bridge bounds reasoning as well as visible output', async () => {
  const model = createDshModel({ async *stream() { yield { type: 'reasoning-delta', text: '12345' }; } }, route, { maxOutputBytes: 4 });
  await assert.rejects(model(request), /limit/);
});
