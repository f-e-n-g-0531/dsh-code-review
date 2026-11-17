import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { retrievalLoop } from '../src/retrieval-loop.mjs';
const read=start=>({kind:'read',id:'s1',start,count:1});
test('same invocation continuation retains accepted evidence, pending requests and chain identity without replay',async()=>{
 const root=createRetrievalScope({id:'s',files:[],context:[{path:'a',text:'first\nsecond\n'}]});let paused=true,calls=0,chain;
 const scope={...root,preflight(ops){if(paused&&ops[0].start===2)throw Object.assign(new Error('reader allocation waiting'),{code:'READER_CALL_BUDGET_EXCEEDED'});return root.preflight(ops);}};
 const model=request=>{calls++;const input=JSON.parse(request.input);if(calls===1)return{requests:[read(1)]};if(calls===2){chain=input.investigationState.chainId;return{requests:[read(2)]};}assert.equal(input.investigationState.chainId,chain);assert.equal(input.retrieved[0].result.text,'first\n');assert.equal(input.retrieved[1].result.text,'second\n');return{findings:[],limitations:[]};};
 let suspended;try{await retrievalLoop(model,{input:'{"snapshotId":"s"}',instructions:'review'},scope,{enableInvestigationState:true,yieldOnBudget:true});}catch(error){suspended=error;}
 assert.equal(typeof suspended.resumeRetrieval,'function');assert.equal(calls,2);assert.equal(root.usage().calls,1);paused=false;
 const result=await suspended.resumeRetrieval(new AbortController().signal);assert.deepEqual(result.findings,[]);assert.equal(calls,3);assert.equal(root.usage().calls,2);
});
test('cancelled continuation neither replays pending requests nor makes another model call',async()=>{
 const root=createRetrievalScope({id:'s',files:[],context:[{path:'a',text:'one'}]});let calls=0;
 const scope={...root,preflight(){throw Object.assign(new Error('wait'),{code:'READER_CALL_BUDGET_EXCEEDED'});}};
 let suspended;try{await retrievalLoop(()=>{calls++;return{requests:[read(1)]};},{input:'{"snapshotId":"s"}',instructions:'review'},scope,{enableInvestigationState:true,yieldOnBudget:true});}catch(error){suspended=error;}
 const controller=new AbortController();controller.abort();await assert.rejects(suspended.resumeRetrieval(controller.signal),/abort/i);assert.equal(calls,1);assert.equal(root.usage().calls,0);
});
