import {createReviewService} from '../src/service.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {checked} from '../src/process.mjs';
import {captureSnapshot} from '../src/snapshot.mjs';
test('real Git automatic current context captured hashed and bounded; untracked and excluded changes cannot reenter',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'dsh-auto-context-'));t.after(async()=>{assert.ok(path.basename(root).startsWith('dsh-auto-context-'));await rm(root,{recursive:true,force:true});});const git=(...args)=>checked('git',args,{cwd:root});
 await git('init','-q');await git('config','user.name','Test');await git('config','user.email','test@example.invalid');
 await writeFile(path.join(root,'a.ts'),'old');await writeFile(path.join(root,'dep.ts'),'export const x = 1;');await git('add','.');await git('commit','-qm','fixture');await writeFile(path.join(root,'a.ts'),"import {x} from './dep';\nimport y from './untracked';");await writeFile(path.join(root,'untracked.ts'),'SECRET');
 const service=createReviewService({async *stream(){throw new Error('Preview must not send');}});const exec={agent:{session:{header:{cwd:root}},options:{provider:'offline',model:'none'}},signal:new AbortController().signal};const preview=await service.preview({autoContext:true,selectedPaths:['a.ts']},exec);assert.deepEqual(preview.autoContext.capturedPaths,['dep.ts']);assert.deepEqual(preview.contextPaths,['dep.ts']);assert.ok(!JSON.stringify(preview).includes('export const x'));await assert.rejects(service.preview({autoContext:'yes'},exec),/Invalid autoContext/);service.dispose();
 const before=await git('status','--porcelain=v1');const s=await captureSnapshot(root,{autoContext:true,selectedPaths:['a.ts']});assert.deepEqual(s.autoContext.capturedPaths,['dep.ts']);assert.equal(s.context[0].text,'export const x = 1;');assert.deepEqual(await git('status','--porcelain=v1'),before);assert.equal(s.id,(await captureSnapshot(root,{autoContext:true,selectedPaths:['a.ts']})).id);assert.notEqual(s.id,(await captureSnapshot(root,{selectedPaths:['a.ts']})).id);
 const explicit=await captureSnapshot(root,{autoContext:true,selectedPaths:['a.ts'],contextPaths:['dep.ts']});assert.equal(explicit.context.length,1);
 await writeFile(path.join(root,'dep.ts'),'changed');const excluded=await captureSnapshot(root,{autoContext:true,selectedPaths:['a.ts']});assert.equal(excluded.context.length,0);
});
