import {reviewSnapshot,REVIEW_INSTRUCTIONS} from '../src/review.mjs';
import {buildCoveragePlan} from '../src/coverage-plan.mjs';
import {createRetrievalScope} from '../src/retrieval-scope.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {riskPlanningDecision} from '../src/risk-plan.mjs';
test('threshold skip uses identical preview and execution counts without skipping main review',async()=>{
 const files=[49,50].map((n,i)=>({...file(n),id:'f'+i,path:'f'+i+'.cpp',eligibility:'reviewable',properties:[]}));const s={id:'s',vcs:'git',context:[],files};const options={enableRiskPlanning:true,skipSmallRiskPlans:true,enableRetrieval:true};
 const p=buildCoveragePlan(s,{...options,instructions:REVIEW_INSTRUCTIONS,scope:createRetrievalScope(s),maxInputBytes:96000});const r=await reviewSnapshot(s,req=>req.instructions.includes('仅制定审查计划')?{risks:[]}:{findings:[],limitations:[]},options);
 assert.equal(p.minimumCalls,3);assert.equal(r.modelCalls,3);assert.equal(r.files[0].riskPlans[0].status,'skipped');assert.equal(r.files[1].riskPlans[0].status,'completed');assert.equal(r.coverage.completed,2);
});
const file=n=>({left:{text:''},right:{text:'changed\n'.repeat(n)}});
test('planning threshold gates exact full-file churn at inclusive 50 and group 100 boundaries',()=>{
 assert.equal(riskPlanningDecision([file(49)]).required,false);assert.equal(riskPlanningDecision([file(50)]).reason,'file-threshold');assert.equal(riskPlanningDecision([file(33),file(33),file(33)]).required,false);assert.equal(riskPlanningDecision([file(34),file(33),file(33)]).reason,'group-threshold');
});
test('unknown churn cannot skip planning and missing sources fail closed',()=>{
 const decision=riskPlanningDecision([{left:{text:'old\n'.repeat(500)},right:{text:'new\n'.repeat(500)}}]);assert.equal(decision.required,true);assert.equal(decision.reason,'unknown-churn');assert.equal(decision.totalChanged,null);assert.throws(()=>riskPlanningDecision([]));assert.throws(()=>riskPlanningDecision([{}]));
});
