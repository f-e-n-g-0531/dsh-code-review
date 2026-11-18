import { reviewOwner } from './review-owner.mjs';
import { safeReviewFailure } from './review-failure.mjs';
import {createReviewArtifacts} from './review-artifacts.mjs';
import {jobProgress} from './job-progress.mjs';
import {recoveryCoverage} from './recovery-coverage.mjs';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {mkdir,open,writeFile,rename,readFile,lstat,realpath,unlink} from 'node:fs/promises';
import path from 'node:path';

const maxPendingCheckpoints=128;
const inspectPreview = 'Inspect preview against current explicit user authorization. For a matching explicit review request, execute with confirmed=true without asking again. Do not execute preview-only or explicit wait-for-confirmation requests; ask for authorization if scope/model/destination exceeds authorization or is unclear. Preserve host permissions and snapshot/identity checks.';
const previewAgain = 'Run a fresh preview before any execution and verify current explicit user authorization. Do not reuse the old preview or approval. A matching explicit review request needs no duplicate confirmation; preview-only or explicit wait-for-confirmation does not authorize execution. Ask if authorization is unclear or the scope/model/destination changes.';

// Report storage is host-owned, never inside a reviewed working copy.
export function createReviewJobs({directory,resolveCwd,previewAvailability}={}){
 if(typeof directory!=='string'||!path.isAbsolute(directory))throw new Error('Absolute host report directory required');
 const artifacts=createReviewArtifacts({directory:path.join(directory,'artifacts')});
 const jobs=new Map(),listeners=new Map();const changed=id=>{for(const fn of [...(listeners.get(id)??[])])fn();};let disposed=false,canonicalDirectory;
 const identity=async exec=>{const o=await reviewOwner(exec,resolveCwd);if(!o.session)throw new Error('Review job requires session identity');const id=o.sessionId;if(typeof id!=='string'||!id)throw new Error('Durable session id required');return {sessionId:id,cwd:o.cwd,provider:o.route.provider,model:o.route.model,reasoningEffort:o.route.reasoningEffort??null};};
 const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 const pageCheckpoint=(c,offset,limit)=>({...c,...(c.files?{files:c.files.slice(offset,offset+limit),totalFiles:c.files.length}:{}),...(c.findings?{findings:c.findings.slice(offset,offset+limit),totalFindings:c.findings.length}: {})});
 const filename=id=>{if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))throw new Error('Invalid review job id');return path.join(canonicalDirectory??directory,id+'.json');};
 // Resolve existing ancestors before appending a not-yet-created suffix. Lexical
 // paths alone do not identify a workspace reached through a junction or symlink.
 async function projectedRealpath(name){
  let current=path.resolve(name);const suffix=[];
  for(;;){
   try{return path.join(await realpath(current),...suffix);}
   catch(error){
    if(error.code!=='ENOENT')throw error;
    // A dangling link is not an ordinary missing directory.
    try{if((await lstat(current)).isSymbolicLink())throw new Error('Unsafe report directory');}catch(statError){if(statError.code!=='ENOENT')throw statError;}
    const parent=path.dirname(current);if(parent===current)throw error;
    suffix.unshift(path.basename(current));current=parent;
   }
  }
 }
 async function checkDirectory(who){
  const [workspace,resolved]=await Promise.all([projectedRealpath(who.cwd),projectedRealpath(directory)]);
  const relative=path.relative(workspace,resolved);
  if(relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)))throw new Error('Report store must be outside reviewed workspace');
  if(canonicalDirectory!==undefined&&resolved!==canonicalDirectory)throw new Error('Unsafe report directory');
  return resolved;
 }
 async function safeDirectory(who){
  const expected=await checkDirectory(who); // Do not even create directories inside the workspace.
  // Use the resolved destination, not a mutable ancestor junction, for creation.
  await mkdir(expected,{recursive:true,mode:0o700});
  const stat=await lstat(directory),resolved=await checkDirectory(who);
  if(stat.isSymbolicLink()||!stat.isDirectory()||resolved!==expected)throw new Error('Unsafe report directory');
  canonicalDirectory??=resolved;
  return stat;
 }
 async function save(job,record=job.record){
  const rootStat=await safeDirectory(record.owner),root=canonicalDirectory;
  const tmp=path.join(root,job.id+'.'+randomUUID()+'.tmp');
  const stats={committedWrites:job.committedWrites+1,resumeWritesSkipped:job.resumeWritesSkipped};
  const pending=job.pendingCheckpoints;
  const committed={...record,...(pending.length?{stage:pending.at(-1).stage??'reviewing',checkpoints:[...record.checkpoints,...pending]}:{}),writeStats:stats};
  const snapshot=JSON.stringify(committed);
  // Exclusive open establishes ownership even if writing the bytes fails partway.
  const handle=await open(tmp,'wx',0o600);
  try{
   await writeFile(handle,snapshot);
   await handle.close();
   await safeDirectory(record.owner);
   await rename(tmp,filename(job.id));
  }catch(error){
   await handle.close().catch(()=>{});
   // Do not follow a replaced directory when cleaning up or mask the save error.
   try{
    const current=await lstat(root);
    if(current.isDirectory()&&current.dev===rootStat.dev&&current.ino===rootStat.ino&&await realpath(root)===root)await unlink(tmp);
   }catch{}
   throw error;
  }
  job.committedWrites=stats.committedWrites;
  job.record=committed;
  pending.length=0;
  changed(job.id);
 }
 async function owned(id,exec,project=r=>r){const who=await identity(exec),job=jobs.get(id);if(job){if(!same(who,job.record.owner))throw new Error('Foreign review job');return project(job.record,job);}await safeDirectory(who);const name=filename(id),stat=await lstat(name);if(stat.isSymbolicLink()||!stat.isFile())throw new Error('Unsafe report file');const r=JSON.parse(await readFile(name,'utf8'));if(!same(who,r.owner)||!same(await identity(exec),r.owner))throw new Error('Foreign review job');if(['queued','running'].includes(r.status)){r.status='interrupted';r.notice='Host restarted or plugin disposed. Saved checkpoints are available; resending requires a fresh preview and approval.';}return project(r);}
 return {
  async start(exec,work){
   if(disposed)throw new Error('Review job service disposed');
   exec.signal?.throwIfAborted();const who=await identity(exec);
   if(disposed)throw new Error('Review job service disposed');
   if([...jobs.values()].some(j=>j.record.owner.sessionId===who.sessionId&&['queued','running'].includes(j.record.status)))throw new Error('Session review job already active');
   const id=randomUUID(),controller=new AbortController(),job={id,controller,committedWrites:0,resumeWritesSkipped:0,settled:false,pendingCheckpoints:[],record:{jobId:id,owner:who,status:'queued',stage:'queued',checkpoints:[],createdAt:new Date().toISOString()},pending:Promise.resolve()};
   // Register the entire lifetime after resolving identity, before persistence: dispose must join
   // startup persistence. The start RPC observes startup errors; done never rejects.
   const liveExec={...exec,signal:controller.signal},session=exec.agent.session;
   const checkOwner=async()=>{if(exec.agent!==liveExec.agent||liveExec.agent.session!==session||!same(who,await identity(liveExec)))throw Object.assign(new Error('Foreign review job: owner changed during review'), { code:'REVIEW_JOB_OWNER_CHANGED' });};
   const startup=Promise.resolve().then(async()=>{await checkOwner();await save(job);});
   const enqueue=fn=>{const operation=job.pending.then(fn);job.pending=operation.catch(()=>{});return operation;};
   job.done=startup.then(async()=>{
    let outcome;
    try{
     controller.signal.throwIfAborted();await checkOwner();
     await enqueue(()=>save(job,{...job.record,status:'running'}));
     controller.signal.throwIfAborted();await checkOwner();
     const result=await work({signal:controller.signal,artifact:async value=>{await checkOwner();const ref=await artifacts.record(id,job.record.owner,value);await enqueue(()=>save(job,{...job.record,artifacts:[...(job.record.artifacts??[]),ref]}));return ref;},saveResumeState:async value=>enqueue(async()=>{
       await checkOwner();
       const previous=job.record.resumeState,next=structuredClone(value);
       // Compare against the last committed continuation, not a failed attempt.
       if(isDeepStrictEqual(previous,next)){job.resumeWritesSkipped++;return;}
       await save(job,{...job.record,resumeState:next});
      }),checkpoint:async value=>enqueue(async()=>{
       await checkOwner();
       if(job.pendingCheckpoints.length>=maxPendingCheckpoints)throw new Error('Pending review checkpoint limit reached after failed saves');
       // Store only JSON-safe checkpoints so a malformed value cannot poison later saves.
       const checkpoint=JSON.parse(JSON.stringify(structuredClone(value)));
       if(!checkpoint||typeof checkpoint!=='object'||Array.isArray(checkpoint))throw new Error('Invalid review checkpoint');
       job.pendingCheckpoints.push(checkpoint);
       await save(job);
      })});
     await checkOwner();outcome={result,status:controller.signal.aborted?'cancelled':'completed'};
    }catch(error){outcome={status:controller.signal.aborted?'cancelled':'failed',error:error?.message??String(error),failure:safeReviewFailure(error)};}
    job.finalizing=true;
    await enqueue(async()=>{
     const final={...job.record,...outcome,finishedAt:new Date().toISOString()};
     try{await save(job,final);jobs.delete(id);}
     catch(error){job.record={...final,executionStatus:outcome.status,status:'failed',persistenceError:error?.message??String(error)};}
     finally{job.pendingCheckpoints.length=0;job.settled=true;changed(id);}
    });
   },()=>{jobs.delete(id);changed(id);});
   jobs.set(id,job);
   // Own cancellation explicitly. The short start RPC ending is NOT cancellation.
   await startup;
   await checkOwner();
   return {jobId:id,status:job.record.status,waitRevision:job.record.checkpoints.length,progress:jobProgress(job.record),nextAction:'Call code_review_wait with waitFor=terminal until terminal status; reuse the returned waitRevision as after without guessing increments. No code_review_status call is needed after each event. Do not finish the user request at start.',notice:'Background job accepted; start is not a completed review. Explicit cancel or plugin disposal stops it.'};
  },
  async resume(id,exec){const r=await owned(id,exec);if(jobs.get(id)&&!jobs.get(id).settled||['queued','running'].includes(r.status)||!r.resumeState)throw new Error('No terminal completed-chain resume state available');return structuredClone(r.resumeState);},
  async priorReview(id,exec){const r=await owned(id,exec);if(jobs.get(id)&&!jobs.get(id).settled||r.status!=='completed'||!r.result?.report?.reviewHistory||r.result.report.outdated)throw new Error('Owned terminal current review history unavailable');return structuredClone(r.result.report.reviewHistory);},
  async artifacts(id,exec,page){const r=await owned(id,exec),result=await artifacts.read(id,r.owner,page);await owned(id,exec);return result;},
  async status(id,exec,page){const r=await owned(id,exec,(record,active)=>{
   const row=structuredClone(record);delete row.resumeState;
   if(active?.finalizing&&!active.settled){row.status='running';row.stage='finalizing';delete row.result;delete row.finishedAt;}
   row.persistence=row.persistenceError!==undefined?'failed':active?'pending':row.status==='interrupted'?'interrupted':'saved';
   if(active)row.writeStats={committedWrites:active.committedWrites,resumeWritesSkipped:active.resumeWritesSkipped};
   return row;
  });
   r.executionStatus??=r.status;
   // A failed final save may expose the report as a process-local diagnostic only.
   const savedEvidence=r.persistence==='failed'?{...r,result:undefined}:r;
   r.recovery=recoveryCoverage(savedEvidence);r.progress=jobProgress(savedEvidence);r.waitRevision=r.checkpoints.length;
   r.nextAction=['queued','running'].includes(r.status)?'Call code_review_wait with waitFor=terminal; reuse the exact returned waitRevision as after, never guess increments. No code_review_status call is needed after each event. Do not end the user request while task runs.':'Collect final report and unfinished scope, then provide one final answer.';
   if(r.result?.previewId){
    if(r.status==='completed'){
     let state;
     try{state=await previewAvailability?.(r.result.previewId,exec);}catch(error){
      if(error?.name==='AbortError')throw error;
     }
     exec.signal?.throwIfAborted();
     r.previewAvailability=state==='available'||state==='expired'?state:'unavailable';
     r.nextAction=r.previewAvailability==='available'?inspectPreview:previewAgain;
    }
    // A durable job result is historical; only a live, owned lease can be executed.
    if(r.previewAvailability!=='available')delete r.result;
   }
   if(!page)return r;
   delete r.error;delete r.persistenceError;
   const {offset=0,limit=20,checkpointIndex,markdown}=page;if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('Invalid result page');if(checkpointIndex!==undefined){if(!Number.isSafeInteger(checkpointIndex)||checkpointIndex<0||checkpointIndex>=r.checkpoints.length)throw new Error('Invalid checkpoint index');return {jobId:r.jobId,status:r.status,executionStatus:r.executionStatus,persistence:r.persistence,writeStats:r.writeStats,waitRevision:r.waitRevision,progress:r.progress,nextAction:r.nextAction,previewAvailability:r.previewAvailability,checkpointIndex,checkpoint:pageCheckpoint(r.checkpoints[checkpointIndex],offset,limit),page:{offset,limit}};}
   const result=r.result;
   const report=result?.report;
   const finalMarkdown=markdown==='technical'?result?.technicalMarkdown:markdown==='user'?result?.markdown:undefined;return {...r,result:undefined,finalMarkdown,recovery:{...r.recovery,unfinishedStages:r.recovery.unfinishedStages.slice(offset,offset+limit),files:r.recovery.files.slice(offset,offset+limit),windows:r.recovery.windows.slice(offset,offset+limit),suggestedPaths:r.recovery.suggestedPaths.slice(offset,offset+limit),totalObservedFiles:r.recovery.files.length},checkpoints:r.checkpoints.slice(offset,offset+limit).map(c=>pageCheckpoint(c,0,limit)),checkpointPage:{offset,limit,total:r.checkpoints.length},...(result?{resultSummary:report?{status:report.status,outdated:report.outdated===true,coverage:report.coverage,model:report.model,snapshotId:report.snapshotId,diagnostics:report.diagnostics,execution:report.execution,modelCalls:report.modelCalls,totalFiles:report.files?.length,totalFindings:report.findings?.length,totalLimitations:report.limitations?.length,totalScopeNotices:report.scopeNotices?.length??0}:({...result,files:result.files?.slice(offset,offset+limit),filePage:result.files?{offset,limit,total:result.files.length}:undefined}),resultPage:report?{files:report.files?.slice(offset,offset+limit),findings:report.findings?.slice(offset,offset+limit),totalFiles:report.files?.length,totalFindings:report.findings?.length}:undefined}: {})};},
  async wait(id,exec,{after,waitFor='progress',timeoutMs=60000,signal}={}){
   const r=await owned(id,exec);
   if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw new Error('Invalid wait duration');
   if(after!==undefined&&(!Number.isSafeInteger(after)||after<0))throw new Error('Invalid wait revision');
   if(!['progress','terminal'].includes(waitFor))throw new Error('Invalid wait mode');
   const revision=after??(jobs.get(id)?.record.checkpoints.length??r.checkpoints.length);
   // Only committed checkpoint revisions wake progress waits. Terminal waits keep
   // their listener across every save and also wake on failed final persistence.
   const ready=()=>{const job=jobs.get(id);return !job||job.settled||(waitFor==='progress'&&job.record.checkpoints.length>revision);};
   if(ready()){await owned(id,exec);return {changed:true,waitFor};}
   signal?.throwIfAborted();
   const didChange=await new Promise((resolve,reject)=>{
    let timer;
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);const waiting=listeners.get(id);waiting?.delete(check);if(waiting?.size===0)listeners.delete(id);};
    const done=value=>{cleanup();resolve(value);},check=()=>{if(ready())done(true);},abort=()=>{cleanup();reject(signal.reason);};
    if(!listeners.has(id))listeners.set(id,new Set());listeners.get(id).add(check);
    signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>done(false),timeoutMs);
    // Close the owned()/listener-registration race without polling or resetting
    // the deadline when irrelevant checkpoint notifications arrive.
    if(signal?.aborted)abort();else check();
   });
   await owned(id,exec);
   return {changed:didChange,waitFor};
  },
  async cancel(id,exec){
   await owned(id,exec);
   const j=jobs.get(id);
   const cancelRequested=!!j&&!j.finalizing&&!j.settled&&!j.controller.signal.aborted&&['queued','running'].includes(j.record.status);
   if(cancelRequested)j.controller.abort(new Error('User cancelled review job'));
   return {jobId:id,cancelRequested};
  },
  async dispose(){disposed=true;for(const j of jobs.values())j.controller.abort(new Error('Review plugin disposed'));await Promise.all([...jobs.values()].map(j=>j.done));}
 };
}
