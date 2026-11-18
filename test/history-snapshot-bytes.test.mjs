import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {checked} from '../src/process.mjs';
import {hash} from '../src/content.mjs';
import {captureGitHistory} from '../src/git-history.mjs';
import {captureSvnHistory} from '../src/svn-history.mjs';

const bytes = value => Buffer.byteLength(JSON.stringify(value));

for(const vcs of ['git','svn'])test(vcs+' historical JSON byte boundaries count escaping, Unicode and excluded rows',async t=>{
  const prefix='dsh-history-json-'+vcs+'-';
  const dir=await mkdtemp(path.join(os.tmpdir(),prefix));
  t.after(async()=>{assert.ok(path.basename(dir).startsWith(prefix));await rm(dir,{recursive:true,force:true});});
  const root=vcs==='git'?dir:path.join(dir,'wc');
  const files=['a.txt','b.txt','.env','z.txt'];
  const set=async text=>{for(const name of files)await writeFile(path.join(root,name),text);};
  let capture,options;
  if(vcs==='git'){
    const git=(...args)=>checked('git',args,{cwd:root});
    await git('init','-q');await git('config','user.name','test');await git('config','user.email','test@example.com');
    await set('old');await git('add','--all');await git('commit','-qm','base');
    await set('变更🙂\n\t"\\');await git('commit','-qam','target');
    capture=captureGitHistory;options={commit:'HEAD'};
  }else{
    const repo=path.join(dir,'repo'),svn=(...args)=>checked('svn',['--non-interactive',...args],{cwd:root});
    await checked('svnadmin',['create',repo]);await checked('svn',['checkout',pathToFileURL(repo).href,root]);
    await set('old');await svn('add',...files);await svn('commit','-m','base');
    await set('变更🙂\n\t"\\');await svn('commit','-m','target');
    capture=captureSvnHistory;options={svnRevision:'2'};
  }
  const selectedPaths=['a.txt','b.txt'];
  const {id,...snapshot}=await capture(root,{...options,selectedPaths});
  assert.deepEqual(snapshot.files.map(f=>f.eligibility),['excluded','reviewable','reviewable','excluded']);
  assert.equal(snapshot.files[1].right.text,'变更🙂\n\t"\\');
  const finalBytes=bytes(snapshot),arrayBytes=bytes(snapshot.files);
  assert.ok(finalBytes>arrayBytes);
  assert.ok(arrayBytes>JSON.stringify(snapshot.files).length);
  assert.equal(id,hash(JSON.stringify(snapshot)));
  assert.deepEqual(await capture(root,{...options,selectedPaths,maxSnapshotBytes:finalBytes}),{...snapshot,id});
  await assert.rejects(capture(root,{...options,selectedPaths,maxSnapshotBytes:finalBytes-1}),/historical snapshot limit exceeded/i);
  const checkedPrefixBytes=bytes(snapshot.files.slice(0,-1));
  const contextPaths=['missing.txt'];
  // Earlier excluded rows still count. A trailing excluded row does not mask a context failure.
  await assert.rejects(capture(root,{...options,selectedPaths,contextPaths,maxSnapshotBytes:checkedPrefixBytes-1}),/historical snapshot limit exceeded/i);
  await assert.rejects(capture(root,{...options,selectedPaths,contextPaths,maxSnapshotBytes:checkedPrefixBytes}),/target regular blob|svn failed/i);
});
