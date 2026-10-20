import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,mkdir,readFile,writeFile} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createReviewJobs} from '../src/review-jobs.mjs';
const exec=id=>({agent:{session:{header:{id,cwd:'/repo'}},options:{provider:'x',model:'m'}}});
test('job returns promptly saves checkpoint and survives start signal cancellation',async t=>{const dir=await mkdtemp(path.join(os.tmpdir(),'review-job-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));const a=exec('a'),b=exec('b'),c=new AbortController();a.signal=c.signal;const jobs=createReviewJobs({directory:dir});let entered,release;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);const start=await jobs.start(a,async({checkpoint})=>{await checkpoint({stage:'file-complete',path:'a.js',status:'completed'});entered();await gate;return {status:'partial'};});c.abort();await ready;assert.equal((await jobs.status(start.jobId,a)).checkpoints.length,1);await assert.rejects(jobs.status(start.jobId,b),/Foreign/);const fresh=createReviewJobs({directory:dir});assert.equal((await fresh.status(start.jobId,a)).status,'interrupted');release();await jobs.dispose();assert.equal((await fresh.status(start.jobId,a)).checkpoints.length,1);await fresh.dispose();});

test('concurrent duplicate start cannot bypass session lock and paged checkpoints preserve all records',async t=>{const dir=await mkdtemp(path.join(os.tmpdir(),'review-job-page-'));t.after(()=>rm(dir,{recursive:true,force:true}));const jobs=createReviewJobs({directory:dir}),a=exec('a');let done,entered;const gate=new Promise(r=>done=r),ready=new Promise(r=>entered=r);const work=async({checkpoint})=>{for(let i=0;i<5;i++)await checkpoint({stage:'window-complete',index:i});entered();await gate;return {report:{status:'partial',files:[],findings:[]}};};const results=await Promise.allSettled([jobs.start(a,work),jobs.start(a,work)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const id=results.find(r=>r.status==='fulfilled').value.jobId;await ready;const p=await jobs.status(id,a,{offset:2,limit:2});assert.equal(p.checkpointPage.total,5);assert.deepEqual(p.checkpoints.map(c=>c.index),[2,3]);const changed=exec('a');changed.agent.options.reasoningEffort='high';await assert.rejects(jobs.status(id,changed),/Foreign/);await jobs.cancel(id,a);done();await jobs.dispose();assert.equal((await jobs.status(id,a)).status,'cancelled');});

test('durable job rejects storing reports inside the reviewed workspace',async()=>{const jobs=createReviewJobs({directory:path.resolve('review-output')});const a=exec('a');a.agent.session.header.cwd=process.cwd();await assert.rejects(jobs.start(a,async()=>({})),/outside reviewed workspace/);await jobs.dispose();});

test('wait wakes on saved checkpoint and does not cancel work when caller stops waiting',async t=>{const dir=await mkdtemp(path.join(os.tmpdir(),'review-wait-'));t.after(()=>rm(dir,{recursive:true,force:true}));const jobs=createReviewJobs({directory:dir}),a=exec('a');let release;const gate=new Promise(r=>release=r);const j=await jobs.start(a,async({checkpoint})=>{await gate;await checkpoint({stage:'done'});return {};});const r=await jobs.status(j.jobId,a),wait=jobs.wait(j.jobId,a,{after:r.checkpoints.length,timeoutMs:1000});release();await wait;await jobs.dispose();assert.ok((await jobs.status(j.jobId,a)).checkpoints.some(c=>c.stage==='done'));});

test('wait abort leaves background running and timeout is not task completion',async t=>{const dir=await mkdtemp(path.join(os.tmpdir(),'review-wait-abort-'));t.after(()=>rm(dir,{recursive:true,force:true}));const jobs=createReviewJobs({directory:dir}),a=exec('a');let release;const gate=new Promise(r=>release=r);const j=await jobs.start(a,async()=>{await gate;return {};});const c=new AbortController();const w=jobs.wait(j.jobId,a,{signal:c.signal,timeoutMs:1000});c.abort(new Error('stop waiting'));await assert.rejects(w,/stop waiting/);await jobs.wait(j.jobId,a,{timeoutMs:10});assert.equal((await jobs.status(j.jobId,a)).status,'running');await assert.rejects(jobs.wait(j.jobId,exec('foreign'),{timeoutMs:10}),/Foreign/);release();await jobs.dispose();});

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};

test('checkpoint save rejection reaches caller but final failed record is durably saved and evicted',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'review-job-recover-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const jobs=createReviewJobs({directory:dir}),a=exec('recover'),ready=deferred(),release=deferred();
 let destination,checkpointError;
 const j=await jobs.start(a,async({checkpoint})=>{
  ready.resolve();await release.promise;
  // Replacing the destination with a directory makes the atomic rename fail.
  await rm(destination);await mkdir(destination);
  await assert.rejects(checkpoint({stage:'file-complete',path:'a.js',status:'completed'}),error=>{checkpointError=error;return ['EPERM','EISDIR','EEXIST','ENOTEMPTY'].includes(error.code);});
  await rm(destination,{recursive:true});throw checkpointError;
 });
 destination=path.join(dir,j.jobId+'.json');await ready.promise;
 const waiting=jobs.wait(j.jobId,a,{after:0,timeoutMs:1000});release.resolve();await waiting;
 await jobs.dispose();
 assert.ok(checkpointError?.code,'original filesystem failure must reach the checkpoint caller');
 const disk=JSON.parse(await readFile(destination,'utf8'));
 assert.equal(disk.status,'failed');assert.equal(disk.error,checkpointError.message);
 assert.equal(disk.checkpoints.length,1);assert.ok(disk.finishedAt);assert.equal(disk.persistenceError,undefined);
 assert.equal((await jobs.cancel(j.jobId,a)).cancelRequested,false,'durably settled job is not retained');
 assert.deepEqual((await jobs.status(j.jobId,a)).checkpoints,disk.checkpoints);
});

test('terminal persistence failure retains diagnostics and wakes waiters without a successful save',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'review-job-final-fail-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const jobs=createReviewJobs({directory:dir}),a=exec('final-fail'),ready=deferred(),release=deferred();
 const j=await jobs.start(a,async()=>{ready.resolve();await release.promise;return {report:{status:'completed',files:[],findings:[]}};});
 await ready.promise;
 const destination=path.join(dir,j.jobId+'.json');await rm(destination);await mkdir(destination);
 const controller=new AbortController();
 const timeout=setTimeout(()=>controller.abort(new Error('terminal waiter was not woken')),1000);
 const waiting=jobs.wait(j.jobId,a,{after:0,timeoutMs:60000,signal:controller.signal});
 release.resolve();
 try{await waiting;}finally{clearTimeout(timeout);}
 await jobs.dispose();
 const result=await jobs.status(j.jobId,a);
 assert.equal(result.status,'failed');assert.ok(result.persistenceError);assert.ok(result.finishedAt);
 assert.equal(result.result.report.status,'completed');
 await assert.rejects(jobs.status(j.jobId,exec('foreign')),/Foreign/);
 assert.equal((await jobs.cancel(j.jobId,a)).cancelRequested,true,'failed final persistence must not evict diagnostics');
});

test('completed reports are read from disk after eviction and ownership is still enforced',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'review-job-evict-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const jobs=createReviewJobs({directory:dir}),a=exec('evict'),ready=deferred(),release=deferred();
 const j=await jobs.start(a,async({checkpoint})=>{await checkpoint({stage:'file-complete',path:'a.js',status:'completed'});ready.resolve();await release.promise;return {previewId:'saved-preview'};});
 await ready.promise;
 const waiting=jobs.wait(j.jobId,a,{after:1,timeoutMs:1000});release.resolve();await waiting;await jobs.dispose();
 assert.equal((await jobs.cancel(j.jobId,a)).cancelRequested,false);
 assert.equal((await jobs.status(j.jobId,a)).status,'completed');
 assert.equal((await jobs.status(j.jobId,a)).result.previewId,'saved-preview');
 await assert.rejects(jobs.status(j.jobId,exec('foreign')),/Foreign/);
 const destination=path.join(dir,j.jobId+'.json'),disk=JSON.parse(await readFile(destination,'utf8'));
 disk.owner.sessionId='different-owner';await writeFile(destination,JSON.stringify(disk));
 await assert.rejects(jobs.status(j.jobId,a),/Foreign/);
 await assert.rejects(jobs.wait(j.jobId,a,{timeoutMs:10}),/Foreign/);
 await assert.rejects(jobs.cancel(j.jobId,a),/Foreign/);
});

test('a handled checkpoint failure does not poison subsequent checkpoint persistence',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'review-job-retry-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const jobs=createReviewJobs({directory:dir}),a=exec('retry'),ready=deferred(),release=deferred(),retried=deferred(),finish=deferred();
 let destination;
 const j=await jobs.start(a,async({checkpoint})=>{
  ready.resolve();await release.promise;
  await rm(destination);await mkdir(destination);
  await assert.rejects(checkpoint({stage:'first'}),error=>['EPERM','EISDIR','EEXIST','ENOTEMPTY'].includes(error.code));
  await rm(destination,{recursive:true});
  await checkpoint({stage:'second'});
  // checkpoint must not resolve before its complete record reaches disk.
  assert.deepEqual(JSON.parse(await readFile(destination,'utf8')).checkpoints.map(c=>c.stage),['first','second']);
  retried.resolve();await finish.promise;return {};
 });
 destination=path.join(dir,j.jobId+'.json');await ready.promise;release.resolve();
 await retried.promise;const waiting=jobs.wait(j.jobId,a,{after:2,timeoutMs:1000});finish.resolve();await waiting;await jobs.dispose();
 assert.equal((await jobs.status(j.jobId,a)).status,'completed');
 assert.equal((await jobs.cancel(j.jobId,a)).cancelRequested,false);
});
