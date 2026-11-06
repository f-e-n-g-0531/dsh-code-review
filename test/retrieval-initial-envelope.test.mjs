import test from 'node:test';
import assert from 'node:assert/strict';
import { initialRetrievalEnvelope } from '../src/retrieval-initial-envelope.mjs';
import { initialInputBudget } from '../src/input-budget.mjs';
import { retrievalLoop } from '../src/retrieval-loop.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
const snapshot={id:'exact-initial',files:[{id:'f',path:'a.js',eligibility:'reviewable',left:{text:'old'},right:{text:'new'}}],context:[]};
const request={input:JSON.stringify({snapshotId:snapshot.id,file:snapshot.files[0]}),instructions:'review'};
for(const maxRounds of [0,3,7])test('planned initial envelope equals actual explicitly configured runtime '+maxRounds,async()=>{
 const scope=createRetrievalScope(snapshot),before=scope.usage(),value={...request,maxRetrievalRounds:maxRounds};
 const planned=initialRetrievalEnvelope(value,scope),budget=initialInputBudget(value,scope,100000);
 let actual;await retrievalLoop(r=>{actual=r;return{findings:[],limitations:[]};},value,scope,{maxRounds,maxInputBytes:budget.bytes});
 assert.equal(actual.input,planned.input);assert.equal(actual.instructions,planned.instructions);
 assert.equal(budget.bytes,Buffer.byteLength(actual.input)+Buffer.byteLength(actual.instructions));
 assert.deepEqual(scope.usage(),before);assert.equal(budget.fits,true);
 assert.equal(initialInputBudget(value,scope,budget.bytes-1).fits,false);
});
test('planning default is explicit production3, not legacy unbounded loop estimate',()=>{
 const p=JSON.parse(initialRetrievalEnvelope(request,createRetrievalScope(snapshot)).input);
 assert.deepEqual(p.retrievalRounds,{max:3,remaining:3});
 assert.throws(()=>initialRetrievalEnvelope(request,createRetrievalScope(snapshot),{maxRounds:-1}));
});

test('nondefault primary preparation metadata measures exact actual initial input',async()=>{
 const { reviewSnapshot }=await import('../src/review.mjs');
 const reportSnapshot={...snapshot,vcs:'git',files:snapshot.files.map(f=>({...f,properties:[]}))};
 let bytes;const report=await reviewSnapshot(reportSnapshot,r=>{bytes=Buffer.byteLength(r.input)+Buffer.byteLength(r.instructions);return{findings:[],limitations:[]};},{enableRetrieval:true,maxRetrievalRounds:10});
 assert.equal(report.files[0].initialInputBytes,bytes);assert.equal(report.files[0].status,'completed');
});
