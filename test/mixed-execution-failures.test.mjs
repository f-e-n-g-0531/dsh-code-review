import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewSnapshot,markdownReport} from '../src/review.mjs';
import {createDshModel} from '../src/dsh-model.mjs';
test('cancellation retains completed primary and cancels only pending approved files',async()=>{
 const controller=new AbortController();let sends=0;
 const report=await reviewSnapshot({id:'s',vcs:'git',context:[],files:[file('done'),file('cancel'),{id:'skip',path:'skip.cpp',eligibility:'excluded'}]},async req=>{sends++;if(sends===2){controller.abort(new Error('user stopped'));throw req.signal.reason;}return {findings:[],limitations:[]};},{signal:controller.signal});
 assert.equal(sends,2);assert.equal(report.status,'cancelled');assert.deepEqual(report.files.map(f=>f.status),['completed','cancelled','excluded']);assert.deepEqual(report.followup.suggestedPaths,['cancel.cpp']);assert.equal(report.coverage.completed,1);
});
test('failure summaries escape untrusted paths and reasons without generating findings',async()=>{
 const report=await reviewSnapshot({id:'s',vcs:'git',context:[],files:[{...file('f'),path:'a<script>.cpp'}]},()=>{throw Error('<img> [fake](https://bad)');});
 const summary=markdownReport(report);assert.ok(!summary.includes('<script>'));assert.ok(!summary.includes('<img>'));assert.ok(summary.includes('&lt;img&gt;'));assert.equal(report.findings.length,0);assert.equal(report.status,'failed');
});
test('empty and all-excluded selections are not represented as completed code review',async()=>{
 for(const files of [[],[{id:'x',path:'x.cpp',eligibility:'excluded'}],[{id:'x',path:'x.cpp',eligibility:'blocked',reason:'binary'}]]){
 const report=await reviewSnapshot({id:'s',vcs:'git',context:[],files},()=>assert.fail('no approved primary send'));assert.equal(report.status,'partial');assert.equal(report.modelCalls,0);assert.equal(report.selection.reviewable,0);assert.equal(report.selection.total,files.length);assert.ok(report.limitations.length);
 }
});
test('unknown provider codes and timeout-looking messages do not become trusted timeout classifications',async()=>{
 for(const error of [Object.assign(Error('Model timeout'),{code:'PROVIDER_SECRET_CODE'}),Error('Model timeout')]){const r=await reviewSnapshot({id:'s',vcs:'git',context:[],files:[file('f')]},()=>{throw error;});assert.equal(r.files[0].failureCode,'REVIEW_EXECUTION_FAILED');assert.ok(!JSON.stringify(r).includes('PROVIDER_SECRET_CODE'));assert.equal(r.status,'failed');}
});
const file=(id,text='new();')=>({id,path:id+'.cpp',eligibility:'reviewable',properties:[],left:{text:'old();'},right:{text}});
test('mixed protocol timeout and input failures retain exact coverage instead of clean bill',async()=>{
 const files=[file('ok'),file('format'),file('timeout'),file('huge','x'.repeat(50000))];let sent=[];
 const report=await reviewSnapshot({id:'s',vcs:'git',context:[],files},async req=>{const id=JSON.parse(req.input).file.id;sent.push(id);
 if(id==='format')return {bugs:[]};if(id==='timeout'){await new Promise(resolve=>req.signal.addEventListener('abort',resolve,{once:true}));throw req.signal.reason;}return {findings:[],limitations:[]};
 },{timeoutMs:25,maxInputBytes:12000});
 assert.equal(report.status,'partial');assert.deepEqual(sent,['ok','format','timeout']);assert.deepEqual(report.files.map(f=>f.status),['completed','failed','failed','blocked']);assert.equal(report.findings.length,0);
 assert.match(report.files[1].reason,/Invalid review response/);assert.match(report.files[2].reason,/timeout/);assert.equal(report.files[2].failureCode,'MODEL_TIMEOUT');assert.equal(report.files[1].failureCode,'REVIEW_EXECUTION_FAILED');assert.match(report.files[3].reason,/输入超过预算/);assert.deepEqual(report.followup.suggestedPaths,['format.cpp','huge.cpp','timeout.cpp']);
 assert.match(markdownReport(report),/partial/);assert.equal(report.coverage.completed,1);assert.equal(report.coverage.failed,2);assert.equal(report.coverage.blocked,1);
});
test('invalid adapter JSON preserves typed error without source disclosure or implicit retry',async()=>{
 let sends=0;const model=createDshModel({async *stream(){sends++;yield {type:'text-delta',text:'SECRET raw explanation'};yield {type:'finish',reason:{kind:'stop'}};}},{provider:'test',model:'test'});
 const report=await reviewSnapshot({id:'s',vcs:'git',context:[],files:[file('f')]},model);
 assert.equal(sends,1);assert.equal(report.status,'failed');assert.match(report.files[0].reason,/not complete JSON/);assert.equal(report.files[0].failureCode,'MODEL_INVALID_JSON');assert.ok(!JSON.stringify(report).includes('SECRET'));assert.equal(report.findings.length,0);
});
