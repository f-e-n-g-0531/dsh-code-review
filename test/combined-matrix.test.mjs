import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewSnapshot} from '../src/review.mjs';
import {buildCoveragePlan} from '../src/coverage-plan.mjs';
import {createRetrievalScope} from '../src/retrieval-scope.mjs';
const N=String.fromCharCode(10);
test('combined rounds windows retrieval reconcile coverage and never widen budget',async()=>{
 const big=['top'];for(let i=0;i<140;i++)big.push('context line '+i+' '+('x'.repeat(70)));
 const right=[...big];right[70]='changed-line-70';
 const files=[
  {id:'a',path:'a.ts',eligibility:'reviewable',properties:[],left:{text:big.join(N)+N},right:{text:right.join(N)+N}},
  {id:'b',path:'b.txt',eligibility:'reviewable',properties:[],left:{text:'old'},right:{text:'new'}},
 ];
 const s={id:'s',vcs:'git',files,context:[{path:'ctx.ts',text:'APPROVED_CONTEXT'+N}]};
 const maxInputBytes=12000, scope=createRetrievalScope(s);
 buildCoveragePlan(s,{instructions:'review',scope,maxInputBytes,reviewRounds:2});
 let reads=0;
 const r=await reviewSnapshot(s,async req=>{const p=JSON.parse(req.input);if(p.contextMode==='approved-retrieval'&&p.contextCatalog?.length&&!p.retrieved?.length){reads++;return {requests:[{kind:'read',id:p.contextCatalog[0].id,start:1,count:1}]};}if(p.retrieved?.length)assert.ok(p.retrieved[0].result.text.includes('APPROVED_CONTEXT'));return {findings:[],limitations:[]};},{enableRetrieval:true,reviewRounds:2,maxInputBytes});
 assert.equal(r.files.length,2);
 const tally=Object.values(r.coverage).reduce((a,b)=>a+b,0);
 assert.equal(tally,files.length);
 assert.equal(r.coverage.completed,r.files.filter(f=>f.status==='completed').length);
 assert.ok(r.files.every(f=>typeof f.status==='string'));
 assert.ok(r.files.every(f=>f.initialInputBytes<=maxInputBytes));
 assert.ok(r.files.every(f=>Array.isArray(f.reviewPasses)&&f.reviewPasses.length===2));
 const windowed=r.files.find(f=>f.sourceMode==='change-windows')||r.files.find(f=>f.windowCoverage);
 assert.ok(windowed);assert.ok(windowed.windowCoverage);
 assert.notEqual(r.status,undefined);
 assert.ok(reads>=1);
});
