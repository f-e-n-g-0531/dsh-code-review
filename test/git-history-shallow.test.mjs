import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {checked} from '../src/process.mjs';import {captureGitHistory} from '../src/git-history.mjs';
test('shallow boundary never masquerades as root and hidden merge parents remain rejected',async t=>{
 const temp=await mkdtemp(path.join(os.tmpdir(),'dsh-shallow-'));t.after(async()=>{assert.ok(path.basename(temp).startsWith('dsh-shallow-'));await rm(temp,{recursive:true,force:true});});const source=path.join(temp,'source');await mkdir(source);const git=(...args)=>checked('git',args,{cwd:source});await git('init');await git('config','user.name','test');await git('config','user.email','test@example.com');await writeFile(path.join(source,'a'),'old');await git('add','.');await git('commit','-m','root');const branch=(await git('symbolic-ref','--short','HEAD')).toString().trim();await git('checkout','-b','side');await writeFile(path.join(source,'b'),'side');await git('add','.');await git('commit','-m','side');await git('checkout',branch);await writeFile(path.join(source,'a'),'new');await git('commit','-am','next');
 const shallow=path.join(temp,'shallow');await checked('git',['clone','--depth','1',pathToFileURL(source).href,shallow]);const status=await checked('git',['status','--porcelain'],{cwd:shallow});await assert.rejects(captureGitHistory(shallow,{commit:'HEAD'}),/git failed/);assert.deepEqual(await checked('git',['status','--porcelain'],{cwd:shallow}),status);
 await git('merge','--no-ff','side','-m','merge');const merge=path.join(temp,'merge');await checked('git',['clone','--depth','1',pathToFileURL(source).href,merge]);await assert.rejects(captureGitHistory(merge,{commit:'HEAD'}),/Merge commit requires/);
});
