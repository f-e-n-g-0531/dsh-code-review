import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, lstat, symlink, writeFile, rename, link, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createReviewArtifacts } from '../src/review-artifacts.mjs';
async function setup(options={}) {
  const base=await mkdtemp(path.join(os.tmpdir(),'dsh-artifacts-')),cwd=path.join(base,'workspace'),directory=path.join(base,'private','artifacts');
  await mkdir(cwd); const owner={sessionId:'session',cwd,provider:'offline',model:'test',reasoningEffort:null};
  return {base,cwd,directory,owner,job:randomUUID(),store:createReviewArtifacts({directory,...options})};
}
const artifact = text => ({status:'failed',format:'dsh-model-output-v1',untrusted:true,blocks:[{type:'text',text}]});

test('private artifacts survive restart while public refs expose no source or paths',async()=>{
  const s=await setup(),value=artifact('PRIVATE_RAW_SOURCE');
  const ref=await s.store.record(s.job,s.owner,value);
  assert.deepEqual(Object.keys(ref).sort(),['artifactId','hash','bytes','status','omitted','recorded'].sort());
  assert.equal(ref.hash,createHash('sha256').update(JSON.stringify(value)).digest('hex'));
  assert.equal(ref.bytes,Buffer.byteLength(JSON.stringify(value)));
  assert.equal(ref.omitted,false);assert.equal(ref.recorded,true);
  assert.ok(!JSON.stringify(ref).includes('PRIVATE_RAW_SOURCE'));assert.ok(!JSON.stringify(ref).includes(s.directory));
  const page=await createReviewArtifacts({directory:s.directory}).read(s.job,s.owner);
  assert.deepEqual(page.artifacts[0].artifact,value);assert.equal(page.totalArtifacts,1);
  if(process.platform!=='win32'){assert.equal((await lstat(s.directory)).mode&0o777,0o700);assert.equal((await lstat(path.join(s.directory,s.job+'.json'))).mode&0o777,0o600);}
});

test('ownership binds every exact identity field and owner is always explicit',async()=>{
  const s=await setup();await s.store.record(s.job,s.owner,artifact('PRIVATE'));
  for(const field of ['sessionId','cwd','provider','model','reasoningEffort']){
    const owner={...s.owner,[field]:field==='cwd'?path.join(s.base,'other'):'foreign'};
    await assert.rejects(s.store.read(s.job,owner),{code:'FOREIGN_REVIEW_ARTIFACT'});
    await assert.rejects(s.store.record(s.job,owner,artifact('OTHER')),{code:'FOREIGN_REVIEW_ARTIFACT'});
  }
  await assert.rejects(s.store.read(s.job),{code:'INVALID_REVIEW_ARTIFACT_OWNER'});
  for(const job of ['../escape','a'.repeat(36),'../../'+s.job])await assert.rejects(s.store.read(job,s.owner),{code:'INVALID_REVIEW_ARTIFACT_JOB'});
});

test('byte and total count caps preserve explicit omitted metadata, never raw truncation',async()=>{
  const value=artifact('small'),bytes=Buffer.byteLength(JSON.stringify(value));
  const s=await setup({maxArtifactBytes:bytes,maxJobBytes:bytes,maxArtifacts:3});
  assert.equal((await s.store.record(s.job,s.owner,value)).omitted,false);
  const total=await s.store.record(s.job,s.owner,value),large=await s.store.record(s.job,s.owner,artifact('PRIVATE'.repeat(1000))),count=await s.store.record(s.job,s.owner,value);
  for(const ref of [total,large,count]){assert.equal(ref.omitted,true);assert.equal(ref.diagnostic,'REVIEW_ARTIFACT_LIMIT_EXCEEDED');}
  assert.equal(count.recorded,false);assert.equal(total.recorded,true);
  const page=await s.store.read(s.job,s.owner);assert.equal(page.totalArtifacts,3);assert.equal(page.artifacts[1].artifact,undefined);assert.equal(page.artifacts[2].artifact,undefined);
  assert.ok(!(await readFile(path.join(s.directory,s.job+'.json'),'utf8')).includes('PRIVATE'));
});

test('concurrent appends across store instances are atomic and paginated',async()=>{
  const s=await setup(),second=createReviewArtifacts({directory:s.directory});
  await Promise.all(Array.from({length:24},(_,i)=>(i%2?s.store:second).record(s.job,s.owner,artifact('value-'+i))));
  const page=await s.store.read(s.job,s.owner,{offset:4,limit:7});assert.equal(page.totalArtifacts,24);assert.equal(page.artifacts.length,7);
  const full=await s.store.read(s.job,s.owner,{limit:100});assert.equal(new Set(full.artifacts.map(r=>r.artifact.blocks[0].text)).size,24);
  assert.deepEqual(await readdir(s.directory),[s.job+'.json']);
  for(const query of [{offset:-1},{limit:101},{limit:0}])await assert.rejects(s.store.read(s.job,s.owner,query),{code:'INVALID_REVIEW_ARTIFACT_PAGE'});
});

test('workspace paths refused before creation including ancestor alias',async()=>{
  const s=await setup(),directory=path.join(s.cwd,'no-create');
  await assert.rejects(createReviewArtifacts({directory}).record(s.job,s.owner,artifact('PRIVATE')),{code:'UNSAFE_REVIEW_ARTIFACT'});
  await assert.rejects(lstat(directory),{code:'ENOENT'});
  const alias=path.join(s.base,'workspace-link');await symlink(s.cwd,alias,process.platform==='win32'?'junction':'dir');
  await assert.rejects(createReviewArtifacts({directory:path.join(alias,'nested')}).record(s.job,s.owner,artifact('PRIVATE')),{code:'UNSAFE_REVIEW_ARTIFACT'});
});

test('symlink roots and files refused; atomic failure never modifies old target',async()=>{
  const s=await setup(),target=path.join(s.base,'target');await mkdir(target);
  const link=path.join(s.base,'linked-store');await symlink(target,link,process.platform==='win32'?'junction':'dir');
  await assert.rejects(createReviewArtifacts({directory:link}).record(s.job,s.owner,artifact('PRIVATE')),{code:'UNSAFE_REVIEW_ARTIFACT'});
  await s.store.record(s.job,s.owner,artifact('before'));const filename=path.join(s.directory,s.job+'.json'),saved=path.join(s.directory,'saved.json');await rename(filename,saved);
  // Windows file symlinks require elevation; directory targets still test no-follow safely.
  await symlink(target,filename,process.platform==='win32'?'junction':'dir');
  await assert.rejects(s.store.read(s.job,s.owner),{code:'UNSAFE_REVIEW_ARTIFACT'});
  await assert.rejects(s.store.record(s.job,s.owner,artifact('after')),{code:'UNSAFE_REVIEW_ARTIFACT'});
  assert.ok((await readFile(saved,'utf8')).includes('before'));assert.deepEqual(await readdir(target),[]);
});

test('serialization rejects accessors cyclic values and hooks without executing them',async()=>{
  const s=await setup();let invoked=false;
  const values=[{get text(){invoked=true;return 'PRIVATE';}},{toJSON(){invoked=true;return 'PRIVATE';}},{status:'PRIVATE'}];
  for(const value of values.slice(0,2))await assert.rejects(s.store.record(s.job,s.owner,value),{code:'INVALID_REVIEW_ARTIFACT'});
  const cyclic={};cyclic.self=cyclic;await assert.rejects(s.store.record(s.job,s.owner,cyclic),{code:'INVALID_REVIEW_ARTIFACT'});assert.equal(invoked,false);
  const ref=await s.store.record(s.job,s.owner,values[2]);assert.equal(ref.status,'unclassified');assert.ok(!JSON.stringify(ref).includes('PRIVATE'));
});

test('filesystem corruption produces safe code only, not private paths or error details',async()=>{
  const s=await setup();await mkdir(s.directory,{recursive:true});await writeFile(path.join(s.directory,s.job+'.json'),'PRIVATE_CORRUPTION');
  await assert.rejects(s.store.read(s.job,s.owner),error=>error.code==='ARTIFACT_STORE_FAILED'&&!error.message.includes('PRIVATE')&&!error.message.includes(s.directory));
});

test('hardlinked artifact files are refused instead of overwriting cross-boundary aliases',async()=>{
  const s=await setup();await s.store.record(s.job,s.owner,artifact('PRIVATE'));
  const name=path.join(s.directory,s.job+'.json');await link(name,path.join(s.cwd,'linked.json'));
  await assert.rejects(s.store.read(s.job,s.owner),{code:'UNSAFE_REVIEW_ARTIFACT'});
  await assert.rejects(s.store.record(s.job,s.owner,artifact('OTHER')),{code:'UNSAFE_REVIEW_ARTIFACT'});
});

test('invalid budgets and byte boundary reject explicitly without hidden truncation',async()=>{
  assert.throws(()=>createReviewArtifacts({directory:'relative'}),{code:'INVALID_REVIEW_ARTIFACT_DIRECTORY'});
  for(const maxArtifactBytes of [0,-1,Infinity,1.5,16777217])assert.throws(()=>createReviewArtifacts({directory:os.tmpdir(),maxArtifactBytes}),{code:'INVALID_REVIEW_ARTIFACT_LIMIT'});
  const value=artifact('é😀'),bytes=Buffer.byteLength(JSON.stringify(value));
  const s=await setup({maxArtifactBytes:bytes-1});const ref=await s.store.record(s.job,s.owner,value);
  assert.equal(ref.bytes,bytes);assert.equal(ref.omitted,true);assert.equal((await s.store.read(s.job,s.owner)).artifacts[0].artifact,undefined);
});

test('default capacity retains 128 small synthetic outputs with unchanged bounded byte limits',async t=>{
 const s=await setup();t.after(()=>rm(s.base,{recursive:true,force:true}));const refs=[];
 for(let i=0;i<128;i++)refs.push(await s.store.record(s.job,s.owner,artifact('synthetic-output-'+i)));
 assert.ok(refs.every(ref=>ref.recorded===true&&ref.omitted===false));
 const first=await s.store.read(s.job,s.owner,{offset:0,limit:100}),last=await createReviewArtifacts({directory:s.directory}).read(s.job,s.owner,{offset:100,limit:100});
 assert.equal(first.totalArtifacts,128);assert.equal(first.artifacts.length,100);assert.equal(last.artifacts.length,28);
 assert.equal(last.artifacts[27].artifact.blocks[0].text,'synthetic-output-127');
 const disk=JSON.parse(await readFile(path.join(s.directory,s.job+'.json'),'utf8'));
 assert.ok(disk.retainedBytes<8388608);assert.equal(disk.retainedBytes,refs.reduce((n,r)=>n+r.bytes,0));
});

test('default job byte cap still omits explicitly before 128 outputs and never stores omitted source',async t=>{
 const s=await setup();t.after(()=>rm(s.base,{recursive:true,force:true}));const value=artifact('x'.repeat(950000)),refs=[];
 for(let i=0;i<10;i++)refs.push(await s.store.record(s.job,s.owner,value));
 assert.equal(refs.filter(r=>!r.omitted).length,8);assert.equal(refs.filter(r=>r.omitted).length,2);
 for(const ref of refs.slice(8)){assert.equal(ref.recorded,true);assert.equal(ref.diagnostic,'REVIEW_ARTIFACT_LIMIT_EXCEEDED');assert.equal(ref.artifact,undefined);}
 const page=await s.store.read(s.job,s.owner);assert.equal(page.totalArtifacts,10);assert.equal(page.artifacts[8].artifact,undefined);
 const oversized=await s.store.record(s.job,s.owner,artifact('OMITTED_SECRET'.repeat(90000)));assert.equal(oversized.omitted,true);
 const disk=JSON.parse(await readFile(path.join(s.directory,s.job+'.json'),'utf8'));assert.ok(disk.retainedBytes<=8388608);assert.ok(!JSON.stringify(disk).includes('OMITTED_SECRET'));
});

test('artifact count configuration rejects invalid or above-10000 limits and accepts the inclusive bound',()=>{
 for(const maxArtifacts of [0,-1,NaN,Infinity,1.5,10001])assert.throws(()=>createReviewArtifacts({directory:os.tmpdir(),maxArtifacts}),{code:'INVALID_REVIEW_ARTIFACT_LIMIT'});
 assert.doesNotThrow(()=>createReviewArtifacts({directory:os.tmpdir(),maxArtifacts:10000}));
 for(const maxJobBytes of [0,-1,Infinity,1.5,268435457])assert.throws(()=>createReviewArtifacts({directory:os.tmpdir(),maxJobBytes}),{code:'INVALID_REVIEW_ARTIFACT_LIMIT'});
});
