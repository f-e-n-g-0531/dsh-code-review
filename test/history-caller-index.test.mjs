import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {checked} from '../src/process.mjs';import {historyCallerIndex,historyCallerProbes} from '../src/history-caller-index.mjs';
import {hash} from '../src/content.mjs';
import {measureSnapshotCapture,snapshotCapturePhase} from '../src/snapshot-capture-metrics.mjs';
async function repo(t){const root=await mkdtemp(path.join(os.tmpdir(),'dsh-history-caller-'));t.after(async()=>{assert.ok(path.basename(root).startsWith('dsh-history-caller-'));await rm(root,{recursive:true,force:true});});const git=(...args)=>checked('git',args,{cwd:root});await git('init');await git('config','user.name','test');await git('config','user.email','test@example.com');return {root,git};}
test('historical scoped caller metadata binds fixed old/new objects never dirty index or working tree',async t=>{const {root,git}=await repo(t);await mkdir(path.join(root,'clients'));await mkdir(path.join(root,'clients','nested'));await writeFile(path.join(root,'clients','a.ts'),'OLD');await writeFile(path.join(root,'clients','nested','b.ts'),'NESTED');await writeFile(path.join(root,'outside.ts'),'OUTSIDE');await git('add','.');await git('update-index','--add','--cacheinfo','120000,'+(await git('hash-object','-w','--stdin')).toString().trim()+',clients/link.ts');await git('commit','-qm','base');const old=(await git('rev-parse','HEAD')).toString().trim();await writeFile(path.join(root,'clients','a.ts'),'NEW');await git('commit','-qam','target');const fresh=(await git('rev-parse','HEAD')).toString().trim();await writeFile(path.join(root,'clients','a.ts'),'DIRTY');await git('add','clients/a.ts');const before=await git('status','--porcelain');const a=await historyCallerIndex(root,old,['clients']),b=await historyCallerIndex(root,fresh,['clients']);assert.deepEqual(a.entries.map(e=>e.path),['clients/a.ts','clients/nested/b.ts']);assert.equal(a.records,3);assert.notEqual(a.entries[0].oid,b.entries[0].oid);assert.notEqual(a.fingerprint,b.fingerprint);const probes=await historyCallerProbes(root,old,['clients','clients/link.ts','missing.ts']);assert.deepEqual(probes.paths,['clients','clients/link.ts']);assert.notEqual(probes.fingerprint,(await historyCallerProbes(root,old,['clients','clients/link.ts','other-missing.ts'])).fingerprint);await assert.rejects(historyCallerIndex(root,'HEAD',['clients']),/fixed/);await assert.rejects(historyCallerIndex(root,old,['clients/a.ts']),/directory/);await assert.rejects(historyCallerIndex(root,old,['clients','clients/nested']),/Overlapping/);await assert.rejects(historyCallerProbes(root,old,['missing','missing']),/Invalid/);assert.deepEqual(await git('status','--porcelain'),before);});
test('historical caller scoped indexes reject more than 256 records rather than silently truncate',async t=>{const {root,git}=await repo(t);await mkdir(path.join(root,'clients'));for(let i=0;i<257;i++)await writeFile(path.join(root,'clients',i+'.ts'),'x');await git('add','.');await git('commit','-qm','base');const oid=(await git('rev-parse','HEAD')).toString().trim();await assert.rejects(historyCallerIndex(root,oid,['clients']),/path limit/);});

test('historical competitor batches preserve single-path fingerprint and bytes on both fixed sides',async t=>{
  const {root,git}=await repo(t);
  await mkdir(path.join(root,'dir'));
  const files=['dir/child.ts','dir/unrequested.ts','-option.ts',' spaced 文本 [x].ts'];
  for(const name of files)await writeFile(path.join(root,name),name);
  await git('add','--all');await git('commit','-qm','base');
  await writeFile(path.join(root,'dir','child.ts'),'new');await git('commit','-qam','target');
  const wanted=['dir','dir/child.ts',files[2],files[3],...Array.from({length:65},(_,i)=>'missing-'+i+'.ts')];
  for(const ref of ['HEAD~1','HEAD']){
    const oid=(await git('rev-parse',ref)).toString().trim();
    const sorted=[...wanted].sort(),chunks=[Buffer.from(oid+'\0')],paths=[];let bytes=0;
    for(const name of sorted){
      const row=await git('--literal-pathspecs','ls-tree','-z',oid,'--',name);
      chunks.push(Buffer.from(name+'\0'),row);bytes+=row.length;if(row.length)paths.push(name);
    }
    const {snapshot,metrics}=await measureSnapshotCapture(()=>snapshotCapturePhase('probes',()=>historyCallerProbes(root,oid,wanted)));
    assert.deepEqual(snapshot,{commit:oid,paths,bytes,fingerprint:hash(Buffer.concat(chunks))});
    assert.equal(metrics.phases.probes.treeQueries,3);
    const stop=new Error('stop historical caller probes');
    await assert.rejects(historyCallerProbes(root,oid,wanted,{signal:AbortSignal.abort(stop)}),error=>error===stop);
    await assert.rejects(historyCallerProbes(root,oid,Array.from({length:513},(_,i)=>'probe-'+i)),/Invalid historical caller probes/);
  }
});
