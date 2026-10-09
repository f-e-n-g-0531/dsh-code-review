import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewSnapshot,REVIEW_INSTRUCTIONS} from '../src/review.mjs';
import {buildCoveragePlan} from '../src/coverage-plan.mjs';
const s={id:'s',vcs:'git',context:[],files:[{id:'f',path:'a.txt',eligibility:'reviewable',properties:[],left:{text:'old'},right:{text:'new'}}]};
test('two independent passes strip first plan and share preview counts',async()=>{let calls=0;const r=await reviewSnapshot(s,req=>{calls++;const p=JSON.parse(req.input);if(calls===1)return {risks:[]};assert.equal(Object.hasOwn(p,'riskPlan'),calls===2);return {findings:[],limitations:[]};},{reviewRounds:2,enableRiskPlanning:true});const p=buildCoveragePlan(s,{reviewRounds:2,enableRiskPlanning:true,instructions:REVIEW_INSTRUCTIONS,maxInputBytes:96000});assert.equal(p.minimumCalls,3);assert.equal(r.modelCalls,3);assert.ok(r.files[0].reviewPasses.every(x=>x.status==='completed'));assert.equal(r.coverage.completed,1);});
test('call cap retains completed first pass but does not claim second or file completion',async()=>{const r=await reviewSnapshot(s,()=>({findings:[],limitations:[]}),{reviewRounds:2,maxCalls:1});assert.equal(r.modelCalls,1);assert.equal(r.files[0].reviewPasses[0].status,'completed');assert.equal(r.files[0].reviewPasses[1].status,'failed');assert.equal(r.coverage.completed,0);});
test('invalid work quantity rejected before sends',async()=>{for(const value of [0,4,1.5,'2'])await assert.rejects(()=>reviewSnapshot(s,()=>assert.fail('send'),{reviewRounds:value}));});
