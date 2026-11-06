import test from 'node:test';
import assert from 'node:assert/strict';
import {retrievalLoop} from '../src/retrieval-loop.mjs';
import {createRetrievalScope} from '../src/retrieval-scope.mjs';
const scope=()=>createRetrievalScope({id:'s',files:[],context:[{path:'approved.js',text:'answer\n'}]});
const base={instructions:'review',input:'{}'};
const final={findings:[],limitations:[]};
const read={requests:[{kind:'read',id:'s1',start:1,count:1}]};
const invalid=events=>events.filter(e=>e.action==='retrieval-protocol-invalid');
for(const correctProtocol of [false,true])test('invalid read schema is reported once before fatal/correction '+correctProtocol,async()=>{
 const events=[];let calls=0,awaited=false;
 const request={...base,onProtocolEvent:async event=>{await Promise.resolve();events.push(event);if(event.action==='retrieval-protocol-invalid')awaited=true;}};
 const model=()=>{if(calls++===0)return{requests:[{kind:'read',id:'PRIVATE_SOURCE',start:'1',count:1}]};assert.equal(awaited,true);return final;};
 if(correctProtocol)assert.deepEqual(await retrievalLoop(model,request,scope(),{correctProtocol}),final);else await assert.rejects(retrievalLoop(model,request,scope(),{correctProtocol}),/Invalid read request/);
 assert.deepEqual(invalid(events),[{action:'retrieval-protocol-invalid',code:'RETRIEVAL_INVALID_SCHEMA'}]);assert.ok(!JSON.stringify(events).includes('PRIVATE_SOURCE'));assert.equal(calls,correctProtocol?2:1);
 if(correctProtocol)assert.ok(events.findIndex(e=>e.action==='retrieval-protocol-invalid')<events.findIndex(e=>e.action==='retrieval-protocol-correction'));
});
test('source authorization and approved reader range failures are separately observable before rejection',async()=>{
 for(const [response,code]of [[{requests:[{kind:'read',id:'PRIVATE_SOURCE',start:1,count:1}]},'RETRIEVAL_UNAUTHORIZED_SOURCE'],[{requests:[{kind:'read',id:'s1',start:9,count:1}]},'RETRIEVAL_INVALID_RANGE']]){
  const events=[],reader=scope();await assert.rejects(retrievalLoop(()=>response,{...base,onProtocolEvent:async e=>events.push(e)},reader));
  assert.deepEqual(invalid(events),[{action:'retrieval-protocol-invalid',code}]);assert.equal(reader.usage().calls,0);assert.ok(!JSON.stringify(events).includes('PRIVATE_SOURCE'));
 }
});
test('all malformed request batches report schema, while malformed final output is not retrieval telemetry',async()=>{
 for(const response of [{requests:[]},{requests:[{kind:'invented',source:'PRIVATE_SOURCE'}]},{requests:[{kind:'search',query:'x',limit:1,sourceIds:[]}]}]){const events=[];await assert.rejects(retrievalLoop(()=>response,{...base,onProtocolEvent:async e=>events.push(e)},scope()));assert.equal(invalid(events).length,1);assert.equal(invalid(events)[0].code,'RETRIEVAL_INVALID_SCHEMA');}
 for(const response of ['{not json','x'.repeat(128*1024+1)]){const events=[];await assert.rejects(retrievalLoop(()=>response,{...base,onProtocolEvent:async e=>events.push(e)},scope()));assert.equal(invalid(events).length,0);}
});
test('actual excess round and input budgets never count as invalid request schema',async()=>{
 const events=[];let calls=0;const result=await retrievalLoop(()=>calls++<2?read:final,{...base,onProtocolEvent:async e=>events.push(e)},scope(),{maxRounds:1});
 assert.deepEqual(result,final);assert.equal(invalid(events).length,0);assert.ok(events.some(e=>e.action==='retrieval-budget-finalization'));
 await assert.rejects(retrievalLoop(()=>assert.fail('send'),{...base,onProtocolEvent:async e=>events.push(e)},scope(),{maxInputBytes:1}));assert.equal(invalid(events).length,0);
});
test('reader budget denial does not emit protocol invalid',async()=>{
 const events=[],reader={...scope(),preflight:()=>{throw Object.assign(new Error('budget'),{code:'READER_OUTPUT_BUDGET_EXCEEDED'});}};let calls=0;
 await retrievalLoop(()=>calls++?final:read,{...base,onProtocolEvent:async e=>events.push(e)},reader);
 assert.equal(invalid(events).length,0);
});
test('final-only known-source request reports unobserved range without touching reader',async()=>{
 const events=[],reader=scope();let preflights=0;const wrapped={...reader,preflight:()=>{preflights++;assert.fail('policy must deny before range preflight');}};
 await assert.rejects(retrievalLoop(()=>({requests:[{kind:'read',id:'s1',start:99999,count:1}]}),{...base,onProtocolEvent:async e=>{await Promise.resolve();events.push(e);}},wrapped,{maxRounds:0}),/final response required/);
 assert.deepEqual(events.filter(e=>e.action==='retrieval-protocol-unobserved'),[{action:'retrieval-protocol-unobserved',code:'RETRIEVAL_RANGE_NOT_OBSERVED'}]);assert.equal(invalid(events).length,0);assert.equal(preflights,0);assert.equal(reader.usage().calls,0);
});
test('actual excess round request is unobserved, not range-valid or invalid, and does not add reads',async()=>{
 const events=[],reader=scope();let calls=0;
 await retrievalLoop(()=>{calls++;return calls===1?read:calls===2?{requests:[{kind:'read',id:'s1',start:99999,count:1}]}:final;},{...base,onProtocolEvent:async e=>events.push(e)},reader,{maxRounds:1});
 assert.equal(events.filter(e=>e.action==='retrieval-protocol-unobserved').length,1);assert.equal(invalid(events).length,0);assert.equal(reader.usage().calls,1);
});
test('final-only malformed request remains invalid-schema, never unobserved; valid normal reads remain observed',async()=>{
 const bad=[];await assert.rejects(retrievalLoop(()=>({requests:[{kind:'read',id:'s1',start:'99999',count:1}]}),{...base,onProtocolEvent:async e=>bad.push(e)},scope(),{maxRounds:0}));assert.equal(invalid(bad).length,1);assert.equal(bad.filter(e=>e.action==='retrieval-protocol-unobserved').length,0);
 const events=[];let calls=0;await retrievalLoop(()=>calls++?final:read,{...base,onProtocolEvent:async e=>events.push(e)},scope(),{maxRounds:1});assert.equal(events.filter(e=>e.action==='retrieval-protocol-unobserved').length,0);
});
test('abort while awaiting unobserved telemetry preserves cancellation reason and performs no read',async()=>{
 const controller=new AbortController(),reason=new Error('cancel telemetry'),reader=scope();
 await assert.rejects(retrievalLoop(()=>read,{...base,signal:controller.signal,onProtocolEvent:async e=>{if(e.action==='retrieval-protocol-unobserved')controller.abort(reason);}},reader,{maxRounds:0}),e=>e===reason);assert.equal(reader.usage().calls,0);
});
test('cancellation before validation emits no post-abort invalid event',async()=>{
 const controller=new AbortController(),reason=new Error('cancelled'),events=[];
 await assert.rejects(retrievalLoop(()=>{controller.abort(reason);return{requests:[]};},{...base,signal:controller.signal,onProtocolEvent:async e=>events.push(e)},scope()),e=>e===reason);
 assert.equal(invalid(events).length,0);
});
