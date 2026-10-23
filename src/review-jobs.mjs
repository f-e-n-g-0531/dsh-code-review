import {createReviewArtifacts} from './review-artifacts.mjs';
import {jobProgress} from './job-progress.mjs';
import {recoveryCoverage} from './recovery-coverage.mjs';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,rename,readFile,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';

// Report storage is host-owned, never inside a reviewed working copy.
export function createReviewJobs({directory}={}){
 if(typeof directory!=='string'||!path.isAbsolute(directory))throw new Error('Absolute host report directory required');
 const artifacts=createReviewArtifacts({directory:path.join(directory,'artifacts')});
 const jobs=new Map(),listeners=new Map();const changed=id=>{for(const fn of [...(listeners.get(id)??[])])fn();};let disposed=false,canonicalDirectory;
 const identity=exec=>{const a=exec?.agent,s=a?.session;if(!s||!a.options?.provider||!a.options?.model||!s.header?.cwd)throw new Error('Review job requires session identity');const id=s.header.id??s.id;if(typeof id!=='string'||!id)throw new Error('Durable session id required');return {sessionId:id,cwd:s.header.cwd,provider:a.options.provider,model:a.options.model,reasoningEffort:a.options.reasoningEffort??null};};
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
 }
 async function save(job){await safeDirectory(job.record.owner);const tmp=path.join(canonicalDirectory,job.id+'.'+randomUUID()+'.tmp'),snapshot=JSON.stringify(job.record),revision=job.record.checkpoints.length;await writeFile(tmp,snapshot,{mode:0o600,flag:'wx'});await safeDirectory(job.record.owner);await rename(tmp,filename(job.id));job.savedRevision=revision;changed(job.id);}
 async function owned(id,exec){const who=identity(exec),job=jobs.get(id);if(job){if(!same(who,job.record.owner))throw new Error('Foreign review job');return job.record;}await safeDirectory(who);const name=filename(id),stat=await lstat(name);if(stat.isSymbolicLink()||!stat.isFile())throw new Error('Unsafe report file');const r=JSON.parse(await readFile(name,'utf8'));if(!same(who,r.owner))throw new Error('Foreign review job');if(['queued','running'].includes(r.status)){r.status='interrupted';r.notice='Host restarted or plugin disposed. Saved checkpoints are available; resending requires a fresh preview and approval.';}return r;}
 return {
  async start(exec,work){
   if(disposed)throw new Error('Review job service disposed');
   exec.signal?.throwIfAborted();const who=identity(exec);
   if([...jobs.values()].some(j=>j.record.owner.sessionId===who.sessionId&&['queued','running'].includes(j.record.status)))throw new Error('Session review job already active');
   const id=randomUUID(),controller=new AbortController(),job={id,controller,savedRevision:0,settled:false,record:{jobId:id,owner:who,status:'queued',stage:'queued',checkpoints:[],createdAt:new Date().toISOString()},pending:Promise.resolve()};
   // Register the entire lifetime before the first await: dispose must also join
   // startup persistence. The start RPC observes startup errors; done never rejects.
   const startup=Promise.resolve().then(()=>save(job));
   const enqueue=fn=>{const operation=job.pending.then(fn);job.pending=operation.catch(()=>{});return operation;};
   job.done=startup.then(async()=>{
    try{
     controller.signal.throwIfAborted();
     job.record.status='running';await enqueue(()=>save(job));
     controller.signal.throwIfAborted();
     const result=await work({signal:controller.signal,artifact:async value=>{const ref=await artifacts.record(id,job.record.owner,value);await enqueue(async()=>{(job.record.artifacts??=[]).push(ref);await save(job);});return ref;},saveResumeState:async value=>enqueue(async()=>{job.record.resumeState=structuredClone(value);await save(job);}),checkpoint:async value=>enqueue(async()=>{job.record.stage=value.stage??'reviewing';job.record.checkpoints.push(structuredClone(value));await save(job);})});
     job.record.result=result;job.record.status=controller.signal.aborted?'cancelled':'completed';
    }catch(error){job.record.status=controller.signal.aborted?'cancelled':'failed';job.record.error=error?.message??String(error);}
    finally{
     job.record.finishedAt=new Date().toISOString();
     try{await enqueue(()=>save(job));jobs.delete(id);}
     catch(error){job.record.status='failed';job.record.persistenceError=error?.message??String(error);}
     finally{job.settled=true;changed(id);}
    }
   },()=>{jobs.delete(id);changed(id);});
   jobs.set(id,job);
   // Own cancellation explicitly. The short start RPC ending is NOT cancellation.
   await startup;
   return {jobId:id,status:job.record.status,waitRevision:job.savedRevision,progress:jobProgress(job.record),nextAction:'Call code_review_wait with waitFor=terminal until terminal status; reuse the returned waitRevision as after without guessing increments. No code_review_status call is needed after each event. Do not finish the user request at start.',notice:'Background job accepted; start is not a completed review. Explicit cancel or plugin disposal stops it.'};
  },
  async resume(id,exec){const r=await owned(id,exec);if(jobs.get(id)&&!jobs.get(id).settled||['queued','running'].includes(r.status)||!r.resumeState)throw new Error('No terminal completed-chain resume state available');return structuredClone(r.resumeState);},
  async artifacts(id,exec,page){const r=await owned(id,exec);return artifacts.read(id,r.owner,page);},
  async status(id,exec,page){const r=structuredClone(await owned(id,exec));delete r.resumeState;const active=jobs.get(id);if(active&&!active.settled&&!['queued','running'].includes(r.status)){r.status='running';r.stage='finalizing';delete r.result;delete r.finishedAt;}r.recovery=recoveryCoverage(r);r.progress=jobProgress(r);r.waitRevision=jobs.get(id)?.savedRevision??r.checkpoints.length;r.nextAction=['queued','running'].includes(r.status)?'Call code_review_wait with waitFor=terminal; reuse the exact returned waitRevision as after, never guess increments. No code_review_status call is needed after each event. Do not end the user request while task runs.':r.result?.previewId?'Show preview and request user confirmation before execute.':'Collect final report and unfinished scope, then provide one final answer.';if(!page)return r;const {offset=0,limit=20,checkpointIndex}=page;if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('Invalid result page');if(checkpointIndex!==undefined){if(!Number.isSafeInteger(checkpointIndex)||checkpointIndex<0||checkpointIndex>=r.checkpoints.length)throw new Error('Invalid checkpoint index');return {jobId:r.jobId,status:r.status,waitRevision:r.waitRevision,progress:r.progress,nextAction:r.nextAction,checkpointIndex,checkpoint:pageCheckpoint(r.checkpoints[checkpointIndex],offset,limit),page:{offset,limit}};}const result=r.result;const report=result?.report;return {...r,result:undefined,recovery:{...r.recovery,unfinishedStages:r.recovery.unfinishedStages.slice(offset,offset+limit),files:r.recovery.files.slice(offset,offset+limit),windows:r.recovery.windows.slice(offset,offset+limit),suggestedPaths:r.recovery.suggestedPaths.slice(offset,offset+limit),totalObservedFiles:r.recovery.files.length},checkpoints:r.checkpoints.slice(offset,offset+limit).map(c=>pageCheckpoint(c,0,limit)),checkpointPage:{offset,limit,total:r.checkpoints.length},...(result?{resultSummary:report?{status:report.status,coverage:report.coverage,model:report.model,snapshotId:report.snapshotId,diagnostics:report.diagnostics,execution:report.execution,modelCalls:report.modelCalls}:({...result,files:result.files?.slice(offset,offset+limit),filePage:result.files?{offset,limit,total:result.files.length}:undefined}),resultPage:report?{files:report.files?.slice(offset,offset+limit),findings:report.findings?.slice(offset,offset+limit),totalFiles:report.files?.length,totalFindings:report.findings?.length}:undefined}: {})};},
  async wait(id,exec,{after,waitFor='progress',timeoutMs=60000,signal}={}){
   const r=await owned(id,exec);
   if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw new Error('Invalid wait duration');
   if(after!==undefined&&(!Number.isSafeInteger(after)||after<0))throw new Error('Invalid wait revision');
   if(!['progress','terminal'].includes(waitFor))throw new Error('Invalid wait mode');
   const revision=after??(jobs.get(id)?.savedRevision??r.checkpoints.length);
   // Only committed checkpoint revisions wake progress waits. Terminal waits keep
   // their listener across every save and also wake on failed final persistence.
   const ready=()=>{const job=jobs.get(id);return !job||job.settled||(waitFor==='progress'&&job.savedRevision>revision);};
   if(ready())return {changed:true,waitFor};
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
   return {changed:didChange,waitFor};
  },
  async cancel(id,exec){await owned(id,exec);const j=jobs.get(id);if(j)j.controller.abort(new Error('User cancelled review job'));return {jobId:id,cancelRequested:!!j};},
  async dispose(){disposed=true;for(const j of jobs.values())j.controller.abort(new Error('Review plugin disposed'));await Promise.all([...jobs.values()].map(j=>j.done));}
 };
}
