import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCoveragePlan} from '../src/coverage-plan.mjs';
import {createRetrievalScope} from '../src/retrieval-scope.mjs';
import {reviewSnapshot,REVIEW_INSTRUCTIONS} from '../src/review.mjs';
const snapshot=()=>({id:'s',vcs:'git',files:[{id:'f',path:'solver.cpp',eligibility:'reviewable',properties:[],left:{text:'before();'},right:{text:'after();'}}],context:[{path:'shared.cpp',text:Array(6000).fill('int unchanged;\n').join('')}]});
test('context-heavy window input uses approved catalog while full context remains exactly readable',async()=>{
 const s=snapshot(),scope=createRetrievalScope(s),plan=buildCoveragePlan(s,{instructions:REVIEW_INSTRUCTIONS,scope,maxInputBytes:12000});
 assert.equal(plan.items[0].status,'ready');assert.equal(plan.items[0].sourceMode,'change-windows');
 let calls=0;const r=await reviewSnapshot(s,async request=>{calls++;const p=JSON.parse(request.input);assert.equal(p.contextMode,'approved-retrieval');assert.deepEqual(p.context,[]);assert.equal(p.contextCatalog.length,1);
 if(!p.retrieved.length)return {requests:[{kind:'read',id:p.contextCatalog[0].id,start:5999,count:2}]};
 assert.equal(p.retrieved[0].result.text,'int unchanged;\nint unchanged;\n');return {findings:[],limitations:[]};
 },{enableRetrieval:true,maxInputBytes:12000});
 assert.equal(calls,2);assert.equal(r.status,'partial');assert.equal(r.files[0].contextMode,'approved-retrieval');assert.equal(r.files[0].initialInputBytes,plan.items[0].initialInputBytes);assert.equal(r.files[0].windowCoverage.completed.length,1);assert.equal(s.context[0].text.length,90000);
});
test('without approved scope context is never discarded to force input acceptance',()=>{
 const plan=buildCoveragePlan(snapshot(),{instructions:REVIEW_INSTRUCTIONS,maxInputBytes:12000});assert.equal(plan.items[0].status,'input-blocked');
});
