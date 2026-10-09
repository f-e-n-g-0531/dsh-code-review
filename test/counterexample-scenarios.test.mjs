import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewSnapshot,markdownReport} from '../src/review.mjs';
for(const scenario of [
 {name:'guard',old:'void run(int* p) { consume(p); }\n',now:'void run(int* p) { if (!p) return; consume(p); }\n',verdict:'refuted',classification:'uncertain',reason:'New-side null guard prevents the alleged null trigger'},
 {name:'unreachable',old:'void run() { work(); }\n',now:'void run() { return; work(); }\n',verdict:'refuted',classification:'uncertain',reason:'Unconditional return prevents reaching alleged operation'},
 {name:'preexisting',old:'void run(int* p) { consume(p); }\n',now:'void run(int* p) { consume(p); log(); }\n',verdict:'supported',classification:'preexisting',reason:'Same null trigger and unguarded consume exist in both approved sides'},
 {name:'missing caller',old:'void run(int* p) { consume(p); }\n',now:'void run(int* p) { consume(p); log(); }\n',verdict:'uncertain',classification:'uncertain',reason:'No approved caller evidence establishes whether null is reachable'}
])test('counterexample pipeline retains candidate honestly: '+scenario.name,async()=>{
 const s={id:'snap',vcs:'git',context:[],files:[{id:'f',path:'a.cpp',eligibility:'reviewable',properties:[],left:{text:scenario.old},right:{text:scenario.now}}]};let calls=0;
 const r=await reviewSnapshot(s,req=>{calls++;const p=JSON.parse(req.input);if(calls===1)return {findings:[{fileId:'f',severity:'high',title:'candidate',evidence:'Hypothesis, not proof',trigger:'alleged trigger',impact:'failure',suggestion:'inspect guard and callers',anchor:{kind:'file'}}],limitations:[]};
 if(!p.retrieved.length)return {requests:['old','new'].map(side=>({kind:'read',id:p.catalog.find(c=>c.side===side).id,start:1,count:1}))};
 const evidence=p.retrieved.map(x=>({receiptId:x.result.receiptId}));return {verdicts:[{candidateId:p.candidates[0].candidateId,verdict:scenario.verdict,reason:scenario.reason,evidence,regression:{classification:scenario.classification,reason:scenario.reason,oldEvidence:[0],newEvidence:[1]}}]};
 },{enableRetrieval:true,enableVerification:true});
 assert.equal(calls,3);assert.equal(r.findings.length,1);const v=r.findings[0].verification;assert.equal(v.status,'completed');assert.equal(v.verdict,scenario.verdict);assert.equal(v.regression.classification,scenario.classification);assert.equal(v.regression.causality,'unverified');assert.deepEqual(v.evidence.map(x=>x.text),[scenario.old,scenario.now]);assert.ok(markdownReport(r).includes(scenario.reason));if(scenario.verdict==='uncertain')assert.equal(r.status,'partial');
});
