import test from 'node:test';
import assert from 'node:assert/strict';
import { defectGuidance } from '../src/defect-guidance.mjs';
import { reviewSnapshot } from '../src/review.mjs';
test('original defect guidance selects language without style rules or shared mutation',()=>{
 for(const [path,language] of [['a.cpp','cpp'],['a.CS','csharp'],['a.ts','javascript'],['a.yaml','configuration'],['a.unknown','generic']]){const a=defectGuidance(path);assert.equal(a.language,language);a.checks.push('mutated');assert.ok(!defectGuidance(path).checks.includes('mutated'));assert.match(a.notice,/not evidence/);}
});
test('language guidance enters actual primary input with no extra reads or calls',async()=>{
 let calls=0;const report=await reviewSnapshot({id:'s',vcs:'git',context:[],files:[{id:'f',path:'a.cpp',eligibility:'reviewable',properties:[],left:{text:'old'},right:{text:'new'}}]},async r=>{calls++;assert.equal(JSON.parse(r.input).defectGuidance.language,'cpp');return {findings:[],limitations:[]};});assert.equal(calls,1);assert.equal(report.status,'completed');
});
