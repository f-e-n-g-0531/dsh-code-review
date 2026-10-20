import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checked } from '../src/process.mjs';
import { captureGit } from '../src/git.mjs';
import { captureGitHistory } from '../src/git-history.mjs';
import { projectInventory } from '../src/project-snapshot.mjs';

test('working, historical and project Git roots retain leading whitespace', async t => {
 const base=await mkdtemp(path.join(os.tmpdir(),'dsh-root-space-'));
 t.after(()=>rm(base,{recursive:true,force:true}));
 const root=path.join(base,' leading root');await mkdir(root);
 const git=(...args)=>checked('git',args,{cwd:root});
 await git('init','-q');await git('config','user.name','test');await git('config','user.email','test@example.invalid');
 await writeFile(path.join(root,'a.js'),'before');await git('add','.');await git('commit','-qm','base');
 const commit=(await git('rev-parse','HEAD')).toString().trim();await writeFile(path.join(root,'a.js'),'after');
 const canonical=await realpath(root);assert.equal((await captureGit(root)).root,canonical);
 assert.equal((await captureGitHistory(root,{commit})).root,canonical);assert.equal((await projectInventory(root,'git')).root,canonical);
});

test('trailing whitespace in Git root survives output newline removal', {skip:process.platform==='win32'?'Win32 normalizes trailing directory spaces':false}, async t => {
 const base=await mkdtemp(path.join(os.tmpdir(),'dsh-root-space-'));t.after(()=>rm(base,{recursive:true,force:true}));
 const root=path.join(base,'trailing root ');await mkdir(root);
 const git=(...args)=>checked('git',args,{cwd:root});await git('init','-q');await git('config','user.name','test');await git('config','user.email','test@example.invalid');
 await writeFile(path.join(root,'a.js'),'before');await git('add','.');await git('commit','-qm','base');const commit=(await git('rev-parse','HEAD')).toString().trim();await writeFile(path.join(root,'a.js'),'after');
 const canonical=await realpath(root);assert.equal((await captureGit(root)).root,canonical);assert.equal((await captureGitHistory(root,{commit})).root,canonical);assert.equal((await projectInventory(root,'git')).root,canonical);
});
