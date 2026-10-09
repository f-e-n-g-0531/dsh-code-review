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
test('combined moderate changes trigger only interaction planning at group threshold with preview parity',async()=>{
 for(const sizes of [[33,33,33],[34,33,33]]){
 const files=sizes.map((n,i)=>({...file(n),id:'f'+i,path:'f'+i+'.cpp',eligibility:'reviewable',properties:[]})),s={id:'s',vcs:'git',context:[],files},options={enableRiskPlanning:true,skipSmallRiskPlans:true,enableRetrieval:true,enableBusinessGrouping:true};
 const p=buildCoveragePlan(s,{...options,instructions:REVIEW_INSTRUCTIONS,scope:createRetrievalScope(s),maxInputBytes:96000});
 const r=await reviewSnapshot(s,req=>req.instructions.includes('仅制定审查计划')?{risks:[]}:{findings:[],limitations:[]},options),expected=sizes[0]===34?5:4;
 assert.equal(p.minimumCalls,expected);assert.equal(r.modelCalls,expected);assert.ok(r.files.every(f=>f.riskPlans[0].status==='skipped'));assert.equal(r.files[2].riskPlans[1].status,sizes[0]===34?'completed':'skipped');assert.equal(p.interactions[0].riskPlanning.required,sizes[0]===34);assert.equal(r.interactions[0].status,'completed');
 }
});
test('tiny visible windows cannot skip full-file planning when approved change churn exceeds threshold',async()=>{
 const f={...file(50),id:'f',path:'f.txt',eligibility:'reviewable',properties:[]};f.left.text='same();\n'.repeat(6000);f.right.text=f.left.text+'changed();\n'.repeat(50);const s={id:'s',vcs:'git',context:[],files:[f]},options={enableRiskPlanning:true,skipSmallRiskPlans:true,enableRetrieval:true,maxInputBytes:12000};
 const p=buildCoveragePlan(s,{...options,instructions:REVIEW_INSTRUCTIONS,scope:createRetrievalScope(s)});const r=await reviewSnapshot(s,req=>req.instructions.includes('仅制定审查计划')?{risks:[]}:{findings:[],limitations:[]},options);
 assert.equal(p.items[0].sourceMode,'change-windows');assert.equal(p.items[0].riskPlanning.required,true);assert.equal(r.files[0].riskPlans[0].decision.totalChanged,50);assert.equal(r.files[0].riskPlans[0].status,'completed');assert.equal(p.minimumCalls,r.modelCalls);
});
test('skip compatibility preserves unconditional planning and cancellation still stops main review',async()=>{
 const s={id:'s',vcs:'git',context:[],files:[{...file(1),id:'f',path:'f.txt',eligibility:'reviewable',properties:[]}]};
 const legacy=await reviewSnapshot(s,req=>req.instructions.includes('仅制定审查计划')?{risks:[]}:{findings:[],limitations:[]},{enableRiskPlanning:true,skipSmallRiskPlans:false});assert.equal(legacy.modelCalls,2);assert.equal(legacy.files[0].riskPlans[0].decision.reason,'unconditional');
 const controller=new AbortController();let sends=0;const cancelled=await reviewSnapshot(s,()=>{sends++;controller.abort(Error('stop'));return {findings:[],limitations:[]};},{enableRiskPlanning:true,skipSmallRiskPlans:true,signal:controller.signal});assert.equal(sends,1);assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.coverage.completed,0);assert.equal(cancelled.files[0].riskPlans[0].status,'skipped');
});
const file=n=>({left:{text:''},right:{text:'changed\n'.repeat(n)}});
test('planning threshold gates exact full-file churn at inclusive 50 and group 100 boundaries',()=>{
 assert.equal(riskPlanningDecision([file(49)]).required,false);assert.equal(riskPlanningDecision([file(50)]).reason,'file-threshold');assert.equal(riskPlanningDecision([file(33),file(33),file(33)]).required,false);assert.equal(riskPlanningDecision([file(34),file(33),file(33)]).reason,'group-threshold');
});
test('unknown churn cannot skip planning and missing sources fail closed',()=>{
 const decision=riskPlanningDecision([{left:{text:'old\n'.repeat(500)},right:{text:'new\n'.repeat(500)}}]);assert.equal(decision.required,true);assert.equal(decision.reason,'unknown-churn');assert.equal(decision.totalChanged,null);assert.throws(()=>riskPlanningDecision([]));assert.throws(()=>riskPlanningDecision([{}]));
});
