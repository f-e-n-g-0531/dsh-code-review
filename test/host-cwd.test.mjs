import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checked } from '../src/process.mjs';
import { createReviewService } from '../src/service.mjs';
import { registerBackgroundReview } from '../src/background-review.mjs';
import { apply } from '../index.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return {promise, resolve}; };
const execution = cwd => ({ agent: {session: {header: {id:'cwd-owner', cwd}}, options: {provider:'test',model:'model'}}, signal: new AbortController().signal });
const snapshot = cwd => ({id:'fixed',vcs:'git',root:cwd,files:[{id:'f',path:'a.js',eligibility:'reviewable',left:{text:'old'},right:{text:'new'},properties:[]}],context:[]});
const emptyModel = {async *stream() {yield {type:'text-delta',text:'{"findings":[],"limitations":[]}'};yield {type:'finish',reason:{kind:'stop'}};}};
async function temporary(t) {const root=await mkdtemp(path.join(os.tmpdir(),'dsh-cwd-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}

test('async trusted cwd replaces stale header, stays live, and cannot authorize absolute repositoryPath', async t => {
  const root=await temporary(t),e=execution('stale-header');let cwd=root, reads=0;
  const service=createReviewService(emptyModel,{resolveCwd:async input=>{assert.equal(input.agent,e.agent);await Promise.resolve();reads++;return cwd;},capture:async target=>{assert.equal(target,cwd);return snapshot(target);},allowModelSending:true,authorize:async()=>true});t.after(()=>service.dispose());
  const p=await service.preview({},e);assert.equal(p.repositoryRoot,root);assert.equal(e.agent.session.header.cwd,'stale-header');
  cwd=root+'-changed';await assert.rejects(service.execute({previewId:p.previewId,confirmed:true},e),error=>error.code==='PREVIEW_DIRECTORY_CHANGED');
  const next=await service.preview({},e);assert.equal(next.repositoryRoot,cwd);assert.ok(reads>=5);
  await assert.rejects(service.preview({repositoryPath:root},e),/relative|path/i);
  await assert.rejects(service.preview({resolveCwd:root},e),/Unknown preview/);
});

test('cwd changing in capture or approval is rejected before model sends', async t => {
  for(const phase of ['capture','approval']) {
    let cwd='/trusted',captures=0,sends=0;
    const service=createReviewService({async *stream(){sends++;yield* emptyModel.stream();}},{resolveCwd:async()=>cwd,capture:async target=>{captures++;if(phase==='capture'&&captures===1)cwd='/changed';return snapshot(target);},allowModelSending:true,authorize:async()=>{cwd='/changed';return true;}});t.after(()=>service.dispose());
    const e=execution('/stale');
    if(phase==='capture')await assert.rejects(service.preview({},e),/directory changed/);
    else {const p=await service.preview({},e);await assert.rejects(service.execute({previewId:p.previewId,confirmed:true},e),/changed/);}
    assert.equal(sends,0);
  }
});

test('cwd change during stream prevents follow-up sends and rejects completed execution', async t => {
  let cwd='/trusted',sends=0;
  const service=createReviewService({async *stream(){sends++;cwd='/changed';yield {type:'text-delta',text:'{"requests":[{"kind":"search","query":"new","limit":1}]}'};yield {type:'finish',reason:{kind:'stop'}};}},{resolveCwd:async()=>cwd,capture:async target=>snapshot(target),allowModelSending:true,authorize:async()=>true});t.after(()=>service.dispose());
  const e=execution('/stale'),p=await service.preview({},e);
  await assert.rejects(service.execute({previewId:p.previewId,confirmed:true},e),/changed/);assert.equal(sends,1);
});

test('production composition uses async host ensure for SVN changes and project preview, not config or header', async t => {
  const dir=await temporary(t),repo=path.join(dir,'repo'),wc=path.join(dir,'wc');
  await checked('svnadmin',['create',repo]);await checked('svn',['checkout',pathToFileURL(repo).href,wc]);
  await writeFile(path.join(wc,'a.js'),'const x=1;');await checked('svn',['add','a.js'],{cwd:wc});await checked('svn',['commit','-m','base'],{cwd:wc});await writeFile(path.join(wc,'a.js'),'const x=2;');
  const definitions=new Map(),dispose=[];const e=execution(path.join(dir,'not-a-repository'));let cwd=wc,calls=0;
  apply({tools:{register:d=>definitions.set(d.name,d)},llm:emptyModel,on:(event,fn)=>{if(event==='dispose')dispose.push(fn);},workingDirectory:{async ensure(agent,signal){assert.equal(agent,e.agent);assert.ok(signal);await Promise.resolve();calls++;return cwd;}}},{executionStrategy:'staged',resolveCwd:'/untrusted-config',cwd:'/untrusted-config'});
  t.after(async()=>{for(const fn of dispose)await fn();});
  for(const args of [{},{reviewMode:'project'}]) {const result=JSON.parse((await definitions.get('code_review_preview').execute(args,e)).json);assert.equal(result.repositoryRoot,await realpath(wc));assert.equal(result.vcs,'svn');const p=result.previewId;cwd=dir;await assert.rejects(definitions.get('code_review_execute').execute({previewId:p,confirmed:true},e),/directory changed/);cwd=wc;}
  const project=JSON.parse((await definitions.get('code_review_preview').execute({reviewMode:'project'},e)).json);
  e.reviewCheckpoint=async value=>{if(value.stage==='approved-manifest')cwd=dir;};
  await assert.rejects(definitions.get('code_review_execute').execute({previewId:project.previewId,confirmed:true},e),/changed/);
  assert.ok(calls>=6);assert.equal(e.agent.session.header.cwd,path.join(dir,'not-a-repository'));
});

test('background start/status/wait/artifacts share live host owner and reject cwd change while waiting', async t => {
  const dir=await temporary(t),workspace=path.join(dir,'workspace'),store=path.join(dir,'store');await mkdir(workspace);let cwd=workspace;
  const e=execution('/stale'),definitions=new Map(),dispose=[];
  const resolveCwd=async()=>{await Promise.resolve();return cwd;};
  const gate=deferred(),ready=deferred();
  const jobs=registerBackgroundReview({tools:{register:d=>definitions.set(d.name,d)},on:(_,fn)=>dispose.push(fn)},{async preview(_args,exec){await exec.reviewCheckpoint({stage:'ready'});ready.resolve();await gate.promise;return {previewId:'captured'};}},{directory:store,resolveCwd});
  t.after(()=>jobs.dispose());
  const call=async(name,args)=>JSON.parse((await definitions.get(name).execute(args,e)).json);
  const start=await call('code_review_start',{phase:'preview'});await ready.promise;const id=start.jobId;
  assert.equal((await call('code_review_status',{jobId:id})).owner.cwd,workspace);
  assert.ok(await call('code_review_artifacts',{jobId:id,confirmed:true}));
  const waiting=jobs.wait(id,e,{waitFor:'terminal',timeoutMs:2000});
  // Allow the wait's asynchronous initial owner check to finish before changing cwd.
  await new Promise(resolve=>setImmediate(resolve));cwd=path.join(dir,'other-workspace');
  for(const name of ['code_review_status','code_review_wait','code_review_artifacts','code_review_cancel']) await assert.rejects(call(name,{jobId:id,confirmed:true,timeoutMs:1}),/Foreign/);
  gate.resolve();await assert.rejects(waiting,/Foreign/);cwd=workspace;
  const final=await call('code_review_wait',{jobId:id,waitFor:'terminal',timeoutMs:2000});assert.equal(final.status,'failed');assert.match(final.error,/owner changed/);
  assert.equal(e.agent.session.header.cwd,'/stale');
});

test('resolver rejection and invalid values fail closed without header fallback', async t => {
  for(const resolveCwd of [async()=>{throw new Error('host unavailable');},async()=>undefined,async()=>({cwd:'/fake'}),'G:/fake']) {
    const service=createReviewService(emptyModel,{resolveCwd,capture:async()=>{assert.fail('capture must not run');}});t.after(()=>service.dispose());
    await assert.rejects(service.preview({},execution('/old')));
  }
});
