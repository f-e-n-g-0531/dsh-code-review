import test from 'node:test';
import assert from 'node:assert/strict';
import { modelResultTools } from '../src/model-tools.mjs';
import { modelContract } from '../src/model-contract.mjs';
import { reviewSinglePass } from '../src/single-pass-review.mjs';
import { validateResponse } from '../src/review.mjs';
import { renderUserReport } from '../src/user-report.mjs';

test('native schema and text contract expose bounded optional change summary', () => {
 const input=JSON.stringify({sourceMode:'single-pass'});
 const member=modelResultTools(input)[0].parameters.properties.reviews.items;
 assert.deepEqual(member.properties.changeSummary,{type:'string',minLength:1,maxLength:2000});
 assert.ok(!member.required.includes('changeSummary'));
 assert.match(modelContract(input),/changeSummary/);
});
test('single-pass response flows into exactly two user report sections in one call', async () => {
 let calls=0;
 const snapshot={id:'s',vcs:'git',context:[],rules:[],files:[{id:'f',path:'task.js',eligibility:'reviewable',properties:[],left:{text:'old();\n',exists:true},right:{text:'new();\n',exists:true}}]};
 const report=await reviewSinglePass(snapshot,()=>{
  calls++;return {reviews:[{fileId:'f',changeSummary:'将旧调用替换为新调用。',findings:[],limitations:[],completion:{status:'completed',gaps:[]},assuranceNotes:[]}],limitations:[],completion:{status:'completed',gaps:[]},assuranceNotes:[]};
 },{validateFindingResponse:validateResponse});
 assert.equal(calls,1);assert.equal(report.status,'completed');
 const text=renderUserReport(report);
 assert.deepEqual(text.match(/^## .+$/gm),['## 1. 改动内容','## 2. 报告']);
 assert.match(text,/将旧调用替换为新调用/);assert.match(text,/未发现明确问题/);
 assert.doesNotMatch(text,/模型调用|耗时|保证等级|覆盖与后续|候选总数/);
});
