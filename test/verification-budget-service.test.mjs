import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewService } from '../src/service.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { checked } from '../src/process.mjs';
const snapshot=()=>({id:'budget-snapshot',root:'/repo',vcs:'git',context:[],files:[{id:'f',path:'a.js',eligibility:'reviewable',properties:[],left:{text:'guard();'},right:{text:'unsafe();'}}]});
const exec=()=>({agent:{session:{header:{cwd:'/repo'}},options:{provider:'fixture',model:'none'}},signal:new AbortController().signal});
function fixture(config={}){let calls=0;const service=createReviewService({async *stream(){calls++;yield{type:'text-delta',text:JSON.stringify({findings:[],limitations:[]})};yield{type:'finish',reason:{kind:'stop'}};}},{capture:async()=>snapshot(),allowModelSending:true,authorize:async()=>true,...config});return{service,get calls(){return calls;}};}

test('default preview discloses primary3 verification6 and unchanged shared root budget',async t=>{
 const f=fixture({optimizeReviewCalls:true});t.after(()=>f.service.dispose());const p=await f.service.preview({},exec());
 assert.equal(p.execution.maxRetrievalRounds,3);assert.equal(p.execution.maxVerificationRetrievalRounds,6);
 assert.match(p.notice,/主审检索最多3轮，候选复核检索最多6轮/);assert.match(p.notice,/共用原根读取调用与字节预算，不增加预算/);assert.match(p.notice,/新增模型调用照常计费/);
 const other=fixture({maxVerificationRetrievalRounds:50,optimizeReviewCalls:true});t.after(()=>other.service.dispose());const q=await other.service.preview({},exec());
 assert.ok(p.execution.readerBudget);assert.deepEqual(p.execution.readerBudget,q.execution.readerBudget);
 assert.equal(f.calls,0);assert.equal(other.calls,0);
});

test('explicit verification config validates0..50 and primary0 defaults final-only',async t=>{
 for(const value of [0,1,6,50]){const f=fixture({maxVerificationRetrievalRounds:value});t.after(()=>f.service.dispose());const e=exec(),p=await f.service.preview({},e);assert.equal(p.execution.maxVerificationRetrievalRounds,value);const r=await f.service.execute({previewId:p.previewId,confirmed:true},e);assert.equal(r.report.execution.maxVerificationRetrievalRounds,value);}
 for(const value of [-1,51,1.5,NaN,Infinity,'6',null]){const invalid=fixture({maxVerificationRetrievalRounds:value});t.after(()=>invalid.service.dispose());await assert.rejects(invalid.service.preview({},exec()),/Retrieval rounds/);}
 const f=fixture({maxRetrievalRounds:0});t.after(()=>f.service.dispose());const e=exec(),p=await f.service.preview({},e);assert.equal(p.execution.maxRetrievalRounds,0);assert.equal(p.execution.maxVerificationRetrievalRounds,0);const r=await f.service.execute({previewId:p.previewId,confirmed:true},e);assert.equal(r.report.execution.maxVerificationRetrievalRounds,0);
});

test('preview policy cannot be overridden at execute and verification limit binds resume identity',async t=>{
 let saved;const f=fixture({maxVerificationRetrievalRounds:4});t.after(()=>f.service.dispose());const e=exec();e.reviewResumeCheckpoint=async value=>{saved=structuredClone(value);};
 let p=await f.service.preview({},e);await assert.rejects(f.service.execute({previewId:p.previewId,confirmed:true,maxVerificationRetrievalRounds:50},e),/Confirmed preview/);
 await f.service.execute({previewId:p.previewId,confirmed:true},e);assert.ok(saved);
 const same=fixture({maxVerificationRetrievalRounds:4}),changed=fixture({maxVerificationRetrievalRounds:5});t.after(()=>same.service.dispose());t.after(()=>changed.service.dispose());e.resolveReviewResume=async()=>saved;
 p=await same.service.preview({resumeFromJobId:'11111111-1111-1111-1111-111111111111'},e);assert.equal(p.execution.maxVerificationRetrievalRounds,4);
 await assert.rejects(changed.service.preview({resumeFromJobId:'11111111-1111-1111-1111-111111111111'},e),/identity mismatch/);
});

test('project preview and batch execution share defaults3/6 and explicit verification0',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'verification-project-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const git=(...args)=>checked('git',args,{cwd:root});await git('init','-q');await writeFile(path.join(root,'a.js'),'const value=1;');await git('add','a.js');
 for(const explicit of [undefined,0]){
  let saved;const f=fixture(explicit===undefined?{}:{maxVerificationRetrievalRounds:explicit});t.after(()=>f.service.dispose());const e=exec();e.agent.session.header.cwd=root;e.reviewResumeCheckpoint=async value=>{saved=structuredClone(value);};
  const p=await f.service.preview({reviewMode:'project'},e);const expected=explicit??6;assert.equal(p.execution.maxRetrievalRounds,3);assert.equal(p.execution.maxVerificationRetrievalRounds,expected);assert.match(p.notice,/Primary retrieval allows at most 3 rounds/);assert.ok(p.notice.includes('verification retrieval allows at most '+expected+' rounds'));
  const r=await f.service.execute({previewId:p.previewId,confirmed:true},e);assert.equal(r.report.execution.maxVerificationRetrievalRounds,expected);assert.equal(r.report.batches[0].readerLimits.maxVerificationRounds,expected);assert.ok(saved);
  const changed=fixture({maxVerificationRetrievalRounds:expected===0?1:7});t.after(()=>changed.service.dispose());e.resolveReviewResume=async()=>saved;
  await assert.rejects(changed.service.preview({reviewMode:'project',resumeFromJobId:'11111111-1111-1111-1111-111111111111'},e),/identity mismatch/);
 }
});
