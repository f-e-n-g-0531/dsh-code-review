import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {setImmediate as nextTurn} from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import {createReviewJobs} from '../src/review-jobs.mjs';
import {registerBackgroundReview} from '../src/background-review.mjs';
import {reviewDiagnostics} from '../src/review-diagnostics.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(t,{background=false,result={report:{status:'partial',files:[],findings:[]},markdown:'# Partial report'}}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'review-wait-cursor-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const cwd=path.join(root,'workspace'),directory=path.join(root,'reports');await fs.mkdir(cwd);
 const exec={agent:{session:{header:{id:'wait-cursor',cwd}},options:{provider:'p',model:'m'}}};
 const gate=deferred(),entered=deferred();let context;
 const work=async value=>{context=value;entered.resolve();await gate.promise;return result;};
 const definitions=[];
 const jobs=background?registerBackgroundReview({tools:{register:d=>definitions.push(d)},on(){}},{execute:(_args,exec)=>work({signal:exec.signal,checkpoint:exec.reviewCheckpoint})},{directory}):createReviewJobs({directory});
 const tool=name=>definitions.find(d=>d.name==='code_review_'+name);
 const started=background?await tool('start').execute({phase:'execute',previewId:'approved',confirmed:true},exec):await jobs.start(exec,work);
 const start=background?JSON.parse(started.json):started;
 await entered.promise;
 t.after(async()=>{gate.resolve();await jobs.dispose();});
 return {root,directory,exec,jobs,gate,start,started,tool,get context(){return context;},destination:path.join(directory,start.jobId+'.json')};
}
function intercept(t,name,implementation){
 const original=fs[name];t.mock.method(fs,name,(...args)=>implementation(original,...args));syncBuiltinESMExports();
 t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
}

test('start and running wait Markdown give exact cursor, identity, elapsed and no status-per-event instructions',async t=>{
 const f=await fixture(t,{background:true});
 for(const key of ['jobId','waitRevision','elapsedMs'])assert.match(f.started.markdown,new RegExp(key+': '+(key==='elapsedMs'?'[0-9]+':f.start[key])));
 assert.match(f.started.markdown,/after.*waitRevision/);assert.match(f.started.markdown,/waitFor=terminal/);
 assert.match(f.started.markdown,/无需每个事件后调用 code_review_status/);
 const status=await f.jobs.status(f.start.jobId,f.exec);
 const output=await f.tool('wait').execute({jobId:f.start.jobId,after:status.waitRevision,timeoutMs:5},f.exec),value=JSON.parse(output.json);
 assert.equal(value.changed,false);assert.equal(value.status,'running');assert.equal(value.waitRevision,status.waitRevision);
 assert.match(output.markdown,new RegExp('waitRevision: '+value.waitRevision));assert.match(output.markdown,new RegExp('elapsedMs: '+value.progress.elapsedMs));
});

test('wait tool declares explicit modes and bounded default 60 second timeout',async t=>{
 const f=await fixture(t,{background:true}),properties=f.tool('wait').parameters.properties;
 assert.deepEqual(properties.waitFor.enum,['progress','terminal']);assert.equal(properties.waitFor.default,'progress');
 assert.equal(properties.timeoutMs.default,60000);assert.equal(properties.timeoutMs.maximum,60000);assert.equal(properties.timeoutMs.minimum,1);
 for(const timeoutMs of [0,-1,60001,1.5,NaN])await assert.rejects(f.jobs.wait(f.start.jobId,f.exec,{timeoutMs}),/Invalid wait duration/);
 for(const after of [-1,1.5,NaN])await assert.rejects(f.jobs.wait(f.start.jobId,f.exec,{after,timeoutMs:1}),/Invalid wait revision/);
 await assert.rejects(f.jobs.wait(f.start.jobId,f.exec,{waitFor:'anything',timeoutMs:1}),/Invalid wait mode/);
});

test('default wait uses one 60s deadline and timeout reports changed=false',async t=>{
 const f=await fixture(t);t.mock.timers.enable({apis:['setTimeout']});
 let settled=false;const waiting=f.jobs.wait(f.start.jobId,f.exec).then(value=>{settled=true;return value;});
 await nextTurn();t.mock.timers.tick(59999);await nextTurn();assert.equal(settled,false);
 t.mock.timers.tick(1);assert.deepEqual(await waiting,{changed:false,waitFor:'progress'});
 t.mock.timers.reset();
});

test('terminal waits ignore all checkpoints but every unknown event is awaited, saved and paged',async t=>{
 const f=await fixture(t);let settled=false;
 const waiting=f.jobs.wait(f.start.jobId,f.exec,{after:0,waitFor:'terminal',timeoutMs:5000}).then(value=>{settled=true;return value;});
 for(let index=0;index<30;index++){
  await f.context.checkpoint({stage:'future-unrecognized-event',index,files:[{path:'a.js'},{path:'b.js'}]});
  const disk=JSON.parse(await fs.readFile(f.destination,'utf8'));assert.equal(disk.checkpoints.length,index+1);assert.equal(disk.checkpoints[index].index,index);
  assert.equal(settled,false);
 }
 const page=await f.jobs.status(f.start.jobId,f.exec,{offset:22,limit:3});
 assert.equal(page.waitRevision,30);assert.equal(page.checkpointPage.total,30);assert.deepEqual(page.checkpoints.map(c=>c.index),[22,23,24]);
 const nested=await f.jobs.status(f.start.jobId,f.exec,{offset:1,limit:1,checkpointIndex:29});assert.deepEqual(nested.checkpoint.files,[{path:'b.js'}]);assert.equal(nested.waitRevision,30);assert.equal(nested.progress.terminal,false);
 f.gate.resolve();assert.deepEqual(await waiting,{changed:true,waitFor:'terminal'});
 assert.equal((await f.jobs.status(f.start.jobId,f.exec)).status,'completed');
});

test('terminal deadline is not reset or satisfied by checkpoint notifications or a guessed cursor',async t=>{
 const f=await fixture(t);t.mock.timers.enable({apis:['setTimeout']});
 let settled=false;const waiting=f.jobs.wait(f.start.jobId,f.exec,{after:999,waitFor:'terminal'}).then(value=>{settled=true;return value;});
 await nextTurn();t.mock.timers.tick(30000);await f.context.checkpoint({stage:'event-one'});await nextTurn();assert.equal(settled,false);
 t.mock.timers.tick(29999);await f.context.checkpoint({stage:'event-two'});await nextTurn();assert.equal(settled,false);
 t.mock.timers.tick(1);assert.deepEqual(await waiting,{changed:false,waitFor:'terminal'});
 t.mock.timers.reset();assert.equal((await f.jobs.status(f.start.jobId,f.exec)).status,'running');
});

test('progress compatibility uses durable cursor and stale cursor catches checkpoints without lost wake',async t=>{
 const f=await fixture(t),id=f.start.jobId;
 const waiting=f.jobs.wait(id,f.exec,{after:0,timeoutMs:1000});
 await f.context.checkpoint({stage:'one'});assert.deepEqual(await waiting,{changed:true,waitFor:'progress'});
 const cursor=(await f.jobs.status(id,f.exec)).waitRevision;assert.equal(cursor,1);
 // Checkpoint between the returned cursor and next wait must not be missed.
 await f.context.checkpoint({stage:'two'});
 assert.equal((await f.jobs.wait(id,f.exec,{after:cursor,timeoutMs:1000})).changed,true);
 assert.equal((await f.jobs.wait(id,f.exec,{after:2,timeoutMs:5})).changed,false);
});

test('progress cursor cannot advance or wake before the checkpoint rename commits',async t=>{
 const f=await fixture(t),entered=deferred(),release=deferred();let block=true;
 intercept(t,'rename',async(original,...args)=>{if(block){block=false;entered.resolve();await release.promise;}return original(...args);});
 let settled=false;const waiting=f.jobs.wait(f.start.jobId,f.exec,{after:0,timeoutMs:1000}).then(value=>{settled=true;return value;});
 const saving=f.context.checkpoint({stage:'not-yet-durable'});await entered.promise;
 try{
  assert.equal((await f.jobs.status(f.start.jobId,f.exec)).waitRevision,0);assert.equal(settled,false);
  assert.equal(JSON.parse(await fs.readFile(f.destination,'utf8')).checkpoints.length,0);
 }finally{release.resolve();}
 await saving;assert.equal((await waiting).changed,true);assert.equal((await f.jobs.status(f.start.jobId,f.exec)).waitRevision,1);
});

test('aborting a terminal wait never cancels background work and later wait still wakes',async t=>{
 const f=await fixture(t),controller=new AbortController();
 const waiting=f.jobs.wait(f.start.jobId,f.exec,{waitFor:'terminal',signal:controller.signal});
 controller.abort(new Error('stop waiting only'));await assert.rejects(waiting,/stop waiting only/);
 assert.equal(f.context.signal.aborted,false);await f.context.checkpoint({stage:'still-running'});
 const later=f.jobs.wait(f.start.jobId,f.exec,{waitFor:'terminal',timeoutMs:1000});f.gate.resolve();assert.equal((await later).changed,true);
 assert.equal((await f.jobs.status(f.start.jobId,f.exec)).status,'completed');
});

test('cancelled and restarted jobs are terminal without source resends and preserve ownership',async t=>{
 const f=await fixture(t),id=f.start.jobId;
 await f.context.checkpoint({stage:'saved'});
 const fresh=createReviewJobs({directory:f.directory}),interrupted=await fresh.status(id,f.exec);
 assert.equal(interrupted.status,'interrupted');assert.equal(interrupted.waitRevision,1);
 assert.equal((await fresh.wait(id,f.exec,{waitFor:'terminal'})).changed,true);
 const foreign=structuredClone(f.exec);foreign.agent.options.model='other';
 for(const jobs of [f.jobs,fresh])await assert.rejects(jobs.wait(id,foreign,{waitFor:'terminal'}),/Foreign/);
 const waiting=f.jobs.wait(id,f.exec,{waitFor:'terminal',timeoutMs:1000});await f.jobs.cancel(id,f.exec);f.gate.resolve();assert.equal((await waiting).changed,true);
 assert.equal((await f.jobs.status(id,f.exec)).status,'cancelled');await fresh.dispose();
});

test('terminal tool returns the complete partial Markdown immediately and keeps report paging',async t=>{
 const report={status:'partial',files:Array.from({length:25},(_,i)=>({path:'file-'+i})),findings:Array.from({length:25},(_,i)=>({title:'finding-'+i})),coverage:{completed:20},modelCalls:46,execution:{fileConcurrency:4,maxRetrievalRounds:3},modulePath:'private-host-path'};
 report.diagnostics=reviewDiagnostics(report,{reviewWallMs:1200,executionWallMs:1500});
 const f=await fixture(t,{background:true,result:{report,markdown:'# Entire partial report\nAll 25 findings'}});
 const waiting=f.tool('wait').execute({jobId:f.start.jobId,after:0,waitFor:'terminal',timeoutMs:1000},f.exec);
 await f.context.checkpoint({stage:'intermediate'});f.gate.resolve();const output=await waiting,value=JSON.parse(output.json);
 assert.equal(value.changed,true);assert.equal(value.status,'completed');assert.equal(value.resultSummary.status,'partial');assert.equal(value.resultPage.totalFindings,25);assert.equal(value.resultPage.findings.length,20);
 assert.deepEqual(value.resultSummary.diagnostics,report.diagnostics);assert.deepEqual(value.resultSummary.execution,report.execution);assert.equal(value.resultSummary.modelCalls,46);
 assert.equal(typeof value.resultSummary.diagnostics.pluginVersion,'string');assert.equal(value.resultSummary.modulePath,undefined);assert.doesNotMatch(JSON.stringify(value.resultSummary),/private-host-path|modulePath|finding-/);
 assert.equal(output.markdown,'# Entire partial report\nAll 25 findings');
 const terminal=await f.tool('wait').execute({jobId:f.start.jobId,after:value.waitRevision,waitFor:'terminal',timeoutMs:1},f.exec);
 assert.equal(terminal.markdown,output.markdown);assert.equal(JSON.parse(terminal.json).changed,true);
 const page=JSON.parse((await f.tool('status').execute({jobId:f.start.jobId,offset:20,limit:5},f.exec)).json);assert.equal(page.resultPage.findings.length,5);
});

test('terminal wait joins final save and exposes failure if the final save fails',async t=>{
 const f=await fixture(t),entered=deferred(),release=deferred();let blocked=false;
 intercept(t,'rename',async(original,...args)=>{
  if(!blocked){blocked=true;entered.resolve();await release.promise;throw new Error('final rename rejected');}
  return original(...args);
 });
 let settled=false;const waiting=f.jobs.wait(f.start.jobId,f.exec,{waitFor:'terminal',timeoutMs:1000}).then(value=>{settled=true;return value;});
 f.gate.resolve();await entered.promise;
 try{assert.equal(settled,false);}finally{release.resolve();}
 assert.equal((await waiting).changed,true);const status=await f.jobs.status(f.start.jobId,f.exec);
 assert.equal(status.status,'failed');assert.match(status.persistenceError,/final rename rejected/);assert.ok(status.finishedAt);assert.equal(status.result.report.status,'partial');
 assert.equal((await f.jobs.wait(f.start.jobId,f.exec,{waitFor:'terminal',timeoutMs:1})).changed,true);
});

test('checkpoint save failure reaches caller and terminal waiter observes failed durable result',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'review-wait-failure-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const directory=path.join(root,'reports'),jobs=createReviewJobs({directory}),exec={agent:{session:{header:{id:'failure',cwd:path.join(root,'workspace')}},options:{provider:'p',model:'m'}}};
 const entered=deferred(),gate=deferred();let fail=false;
 intercept(t,'writeFile',async(original,...args)=>{if(fail){fail=false;throw new Error('checkpoint write failed');}return original(...args);});
 const started=await jobs.start(exec,async({checkpoint})=>{entered.resolve();await gate.promise;fail=true;await checkpoint({stage:'failing'});});await entered.promise;
 const waiting=jobs.wait(started.jobId,exec,{after:0,waitFor:'terminal',timeoutMs:1000});gate.resolve();assert.equal((await waiting).changed,true);
 const status=await jobs.status(started.jobId,exec);assert.equal(status.status,'failed');assert.match(status.error,/checkpoint write failed/);assert.equal(status.waitRevision,1);
 const disk=JSON.parse(await fs.readFile(path.join(directory,started.jobId+'.json'),'utf8'));assert.equal(disk.status,'failed');assert.equal(disk.checkpoints.length,1);await jobs.dispose();
});

test('concurrent progress and terminal listeners survive checkpoint notifications independently',async t=>{
 const f=await fixture(t),id=f.start.jobId;
 let terminalSettled=false;const terminal=f.jobs.wait(id,f.exec,{waitFor:'terminal',timeoutMs:1000}).then(value=>{terminalSettled=true;return value;});
 const progress=f.jobs.wait(id,f.exec,{after:0,timeoutMs:1000});
 await f.context.checkpoint({stage:'first'});assert.equal((await progress).changed,true);assert.equal(terminalSettled,false);
 const second=f.jobs.wait(id,f.exec,{after:1,timeoutMs:1000});
 await f.context.checkpoint({stage:'second'});assert.equal((await second).changed,true);assert.equal(terminalSettled,false);
 f.gate.resolve();assert.equal((await terminal).changed,true);
});

test('terminal waiter reports actual work failure without requiring a checkpoint increment',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'review-wait-work-failure-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const jobs=createReviewJobs({directory:path.join(root,'reports')}),exec={agent:{session:{header:{id:'work-failure',cwd:path.join(root,'workspace')}},options:{provider:'p',model:'m'}}};
 const entered=deferred(),gate=deferred();
 const start=await jobs.start(exec,async()=>{entered.resolve();await gate.promise;throw new Error('model execution rejected');});await entered.promise;
 const waiting=jobs.wait(start.jobId,exec,{waitFor:'terminal',after:0,timeoutMs:1000});gate.resolve();assert.equal((await waiting).changed,true);
 const status=await jobs.status(start.jobId,exec);assert.equal(status.status,'failed');assert.equal(status.waitRevision,0);assert.match(status.error,/model execution rejected/);await jobs.dispose();
});


test('future progress cursor waits through equal revisions, times out false, and wakes only when strictly newer',async t=>{
 const f=await fixture(t),id=f.start.jobId;
 const cursor=(await f.jobs.status(id,f.exec)).waitRevision;
 assert.equal((await f.jobs.wait(id,f.exec,{after:cursor+1,timeoutMs:5})).changed,false);
 assert.equal((await f.jobs.wait(id,f.exec,{after:99,timeoutMs:5})).changed,false);
 let settled=false;const waiting=f.jobs.wait(id,f.exec,{after:1,timeoutMs:1000}).then(value=>{settled=true;return value;});
 await f.context.checkpoint({stage:'equal-to-guessed-cursor'});assert.equal((await f.jobs.status(id,f.exec)).waitRevision,1);assert.equal(settled,false);
 await f.context.checkpoint({stage:'strictly-newer'});assert.equal((await waiting).changed,true);
 assert.equal((await f.jobs.wait(id,f.exec,{after:2,timeoutMs:5})).changed,false);
 const terminal=f.jobs.wait(id,f.exec,{after:99,waitFor:'terminal',timeoutMs:1000});
 const futureProgress=f.jobs.wait(id,f.exec,{after:99,timeoutMs:1000});
 f.gate.resolve();assert.equal((await terminal).changed,true);assert.equal((await futureProgress).changed,true);
});
