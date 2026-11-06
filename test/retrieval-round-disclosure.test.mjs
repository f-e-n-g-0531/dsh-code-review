import test from'node:test';
import assert from'node:assert/strict';
import{retrievalLoop,retrievalRequest}from'../src/retrieval-loop.mjs';
import{createRetrievalScope}from'../src/retrieval-scope.mjs';
test('all retrieval stages disclose live request rounds without search seeds',async()=>{
 const scope=createRetrievalScope({id:'s',files:[{id:'f',path:'a.js',eligibility:'reviewable',left:{text:'old();'},right:{text:'new();'},properties:[]}],context:[]});
 const seen=[];const id=scope.catalog().find(s=>s.side==='new').id;
 await retrievalLoop(req=>{const p=JSON.parse(req.input);seen.push(p.retrievalRounds);return seen.length===1?{requests:[{kind:'read',id,start:1,count:1}]}:{verdicts:[]};},{input:JSON.stringify({snapshotId:'s',candidates:[]}),instructions:'verify'},scope,{maxRounds:6,maxInputBytes:98304,enableSearchSeeds:false});
 assert.deepEqual(seen,[{max:6,remaining:6},{max:6,remaining:5}]);
});
test('seed admission can measure exact same initial stage-round annotation',async()=>{
 const scope=createRetrievalScope({id:'s',files:[],context:[]});const request={input:JSON.stringify({snapshotId:'s',candidates:[]}),instructions:'verify'};
 const expected=retrievalRequest(request,scope,[],{max:6,remaining:6});
 await retrievalLoop(actual=>{assert.equal(actual.input,expected.input);return {verdicts:[]};},request,scope,{maxRounds:6,maxInputBytes:98304,enableSearchSeeds:false});
});
test('actual extra retrieval is denied and recorded without executing a second read batch',async()=>{
 const scope=createRetrievalScope({id:'s',files:[{id:'f',path:'a.js',eligibility:'reviewable',left:{text:'old();'},right:{text:'new();'},properties:[]}],context:[]});const id=scope.catalog().find(s=>s.side==='new').id;let calls=0;const limited=[];
 await retrievalLoop(req=>{calls++;if(calls<=2)return{requests:[{kind:'read',id,start:1,count:1}]};assert.equal(JSON.parse(req.input).retrievalFinalization.code,'RETRIEVAL_ROUND_BUDGET_EXCEEDED');return{verdicts:[]};},{input:'{}',instructions:'verify'},scope,{maxRounds:1,maxInputBytes:98304,onBudgetLimited:v=>limited.push(v)});
 assert.equal(calls,3);assert.equal(scope.usage().calls,1);assert.equal(limited.length,1);
});
