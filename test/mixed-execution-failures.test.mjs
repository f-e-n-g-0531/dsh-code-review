import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewSnapshot,markdownReport} from '../src/review.mjs';
import {createDshModel} from '../src/dsh-model.mjs';
const file=(id,text='new();')=>({id,path:id+'.cpp',eligibility:'reviewable',properties:[],left:{text:'old();'},right:{text}});
test('mixed protocol timeout and input failures retain exact coverage instead of clean bill',async()=>{
 const files=[file('ok'),file('format'),file('timeout'),file('huge','x'.repeat(50000))];let sent=[];
 const report=await reviewSnapshot({id:'s',vcs:'git',context:[],files},async req=>{const id=JSON.parse(req.input).file.id;sent.push(id);
 if(id==='format')return {bugs:[]};if(id==='timeout'){await new Promise(resolve=>req.signal.addEventListener('abort',resolve,{once:true}));throw req.signal.reason;}return {findings:[],limitations:[]};
 },{timeoutMs:25,maxInputBytes:12000});
 assert.equal(report.status,'partial');assert.deepEqual(sent,['ok','format','timeout']);assert.deepEqual(report.files.map(f=>f.status),['completed','failed','failed','blocked']);assert.equal(report.findings.length,0);
 assert.match(report.files[1].reason,/Invalid review response/);assert.match(report.files[2].reason,/timeout/);assert.match(report.files[3].reason,/输入超过预算/);assert.deepEqual(report.followup.suggestedPaths,['format.cpp','huge.cpp','timeout.cpp']);
 assert.match(markdownReport(report),/partial/);assert.equal(report.coverage.completed,1);assert.equal(report.coverage.failed,2);assert.equal(report.coverage.blocked,1);
});
test('invalid adapter JSON preserves typed error without source disclosure or implicit retry',async()=>{
 let sends=0;const model=createDshModel({async *stream(){sends++;yield {type:'text-delta',text:'SECRET raw explanation'};yield {type:'finish',reason:{kind:'stop'}};}},{provider:'test',model:'test'});
 const report=await reviewSnapshot({id:'s',vcs:'git',context:[],files:[file('f')]},model);
 assert.equal(sends,1);assert.equal(report.status,'failed');assert.match(report.files[0].reason,/not complete JSON/);assert.ok(!JSON.stringify(report).includes('SECRET'));assert.equal(report.findings.length,0);
});
