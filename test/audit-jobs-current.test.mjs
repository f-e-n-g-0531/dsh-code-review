import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {createReviewJobs} from '../src/review-jobs.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const exec=(cwd,id='session')=>({agent:{session:{header:{id,cwd}},options:{provider:'test',model:'test'}}});
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'review-jobs-audit-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const cwd=path.join(root,'workspace');await fs.mkdir(cwd);
 return {root,cwd,directory:path.join(root,'reports')};
}
function interceptWrites(t,implementation){
 const original=fs.writeFile;
 t.mock.method(fs,'writeFile',(...args)=>implementation(original,...args));syncBuiltinESMExports();
 t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
}

for(const phase of [1,2])for(const action of ['dispose','cancel']){
 test(`${action} during persistence ${phase} prevents work and joins terminal save`,async t=>{
  const {cwd,directory}=await fixture(t),a=exec(cwd),jobs=createReviewJobs({directory});
  const entered=deferred(),release=deferred();let writes=0,jobId,calls=0;
  interceptWrites(t,async(original,name,...args)=>{
   if(++writes===phase){jobId=path.basename(name).slice(0,36);entered.resolve();await release.promise;}
   return original(name,...args);
  });
  const starting=jobs.start(a,async()=>{calls++;throw new Error('work must not run');});
  await entered.promise;
  let disposal,settled=false;
  if(action==='dispose'){
   disposal=jobs.dispose().then(()=>{settled=true;});
   await Promise.resolve();await Promise.resolve();
   assert.equal(settled,false,'dispose must join pending persistence, including first save');
  }else assert.equal((await jobs.cancel(jobId,a)).cancelRequested,true);
  release.resolve();const started=await starting;
  if(disposal)await disposal;else await jobs.dispose();
  assert.equal(calls,0);
  const disk=JSON.parse(await fs.readFile(path.join(directory,started.jobId+'.json'),'utf8'));
  assert.equal(disk.status,'cancelled');assert.ok(disk.finishedAt);
  assert.equal((await jobs.cancel(started.jobId,a)).cancelRequested,false);
 });
}

test('first persistence failure rejects start, joins disposal and releases session lock',async t=>{
 const {cwd,directory}=await fixture(t),a=exec(cwd),jobs=createReviewJobs({directory});
 const entered=deferred(),release=deferred();let fail=true,calls=0;
 interceptWrites(t,async(original,...args)=>{
  if(fail){fail=false;entered.resolve();await release.promise;throw new Error('initial persistence failed');}
  return original(...args);
 });
 const starting=jobs.start(a,async()=>{calls++;return {};});
 const rejected=assert.rejects(starting,/initial persistence failed/);
 await entered.promise;
 await assert.rejects(jobs.start(a,async()=>{}),/already active/);
 release.resolve();await rejected;
 const retried=await jobs.start(a,async()=>{calls++;return {};});
 await jobs.dispose();assert.equal((await jobs.cancel(retried.jobId,a)).cancelRequested,false);
 assert.ok(calls<=1);
});

test('dispose during failed initial persistence settles without running work or unhandled rejection',async t=>{
 const {cwd,directory}=await fixture(t),a=exec(cwd),jobs=createReviewJobs({directory});
 const entered=deferred(),release=deferred();let calls=0;
 interceptWrites(t,async()=>{entered.resolve();await release.promise;throw new Error('startup failure');});
 const rejected=assert.rejects(jobs.start(a,async()=>{calls++;}),/startup failure/);
 await entered.promise;const disposal=jobs.dispose();release.resolve();
 await Promise.all([disposal,rejected]);assert.equal(calls,0);
 await assert.rejects(jobs.start(a,async()=>{}),/disposed/);
});

const linkDirectory=(target,name)=>fs.symlink(target,name,process.platform==='win32'?'junction':'dir');
for(const existing of [false,true])test(`cwd junction alias rejects ${existing?'existing':'missing'} real workspace report directory without writes`,async t=>{
 const {root,cwd}=await fixture(t),alias=path.join(root,'workspace-alias');
 await linkDirectory(cwd,alias);
 const directory=path.join(cwd,'reports','nested');
 if(existing)await fs.mkdir(directory,{recursive:true});
 const before=await fs.readdir(cwd,{recursive:true});
 const jobs=createReviewJobs({directory});let calls=0;
 await assert.rejects(jobs.start(exec(alias),async()=>{calls++;}),/outside reviewed workspace/);
 await jobs.dispose();assert.equal(calls,0);
 assert.deepEqual(await fs.readdir(cwd,{recursive:true}),before,'rejection must not create workspace directories or reports');
});

test('report ancestor junction cannot hide a missing destination inside workspace',async t=>{
 const {root,cwd}=await fixture(t),ancestor=path.join(root,'host-alias');
 await linkDirectory(cwd,ancestor);
 const jobs=createReviewJobs({directory:path.join(ancestor,'missing','reports')});
 await assert.rejects(jobs.start(exec(cwd),async()=>{}),/outside reviewed workspace/);
 await jobs.dispose();assert.deepEqual(await fs.readdir(cwd),[]);
});

test('retargeted ancestor is rejected again before checkpoint mkdir and final persistence',async t=>{
 const {root,cwd}=await fixture(t),host=path.join(root,'host'),alias=path.join(root,'host-alias');
 await fs.mkdir(host);await linkDirectory(host,alias);
 const directory=path.join(alias,'reports'),jobs=createReviewJobs({directory}),a=exec(cwd);
 const ready=deferred(),release=deferred();
 const started=await jobs.start(a,async({checkpoint})=>{
  ready.resolve();await release.promise;
  await assert.rejects(checkpoint({stage:'blocked'}),/outside reviewed workspace/);
  throw new Error('report directory changed');
 });
 await ready.promise;
 await fs.unlink(alias);await linkDirectory(cwd,alias);release.resolve();
 await jobs.dispose();
 assert.deepEqual(await fs.readdir(cwd),[],'revalidation must precede creation in retargeted workspace');
 const status=await jobs.status(started.jobId,a);
 assert.equal(status.status,'failed');assert.match(status.persistenceError,/outside reviewed workspace/);
});

test('external ancestor junction and nonexistent cwd suffix preserve supported storage',async t=>{
 const {root,cwd}=await fixture(t),host=path.join(root,'host'),alias=path.join(root,'host-alias');
 await fs.mkdir(host);await linkDirectory(host,alias);
 const jobs=createReviewJobs({directory:path.join(alias,'new','reports')}),a=exec(path.join(cwd,'not-created'));
 const started=await jobs.start(a,async()=>({ok:true}));await jobs.dispose();
 assert.equal((await jobs.cancel(started.jobId,a)).cancelRequested,false);
 assert.ok(['cancelled','completed'].includes((await jobs.status(started.jobId,a)).status));
 assert.deepEqual(await fs.readdir(cwd),[]);
});
