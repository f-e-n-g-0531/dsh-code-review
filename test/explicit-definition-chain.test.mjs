import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {checked} from '../src/process.mjs';import {captureSnapshot} from '../src/snapshot.mjs';import {captureDependencyChain} from '../src/dependency-chain.mjs';import {createReviewService} from '../src/service.mjs';
async function fixture(fn){const root=await mkdtemp(path.join(os.tmpdir(),'dsh-explicit-chain-'));try{
 const git=(...a)=>checked('git',a,{cwd:root}),put=(n,t)=>writeFile(path.join(root,'src',n),t);await git('init','-q');await git('config','user.email','test@example.invalid');await git('config','user.name','Test');await mkdir(path.join(root,'src'));
 await put('change.ts','export const x=1;');await put('seed.ts','export {run} from "./impl";');await put('impl.ts','export {run} from "./end";');await put('end.ts','export function run(){}');await git('add','.');await git('commit','-qm','base');await put('change.ts','export const x=2;');await fn({root,git,put});
}finally{assert.ok(path.basename(root).startsWith('dsh-explicit-chain-'));await rm(root,{recursive:true,force:true});}}
test('explicit seeds traverse only with autoContext and share context slots and bytes',()=>fixture(async({root})=>{
 const options={contextPaths:['src/seed.ts']};assert.deepEqual((await captureSnapshot(root,options)).context.map(c=>c.path),['src/seed.ts']);
 const s=await captureSnapshot(root,{...options,autoContext:true});assert.deepEqual(s.context.map(c=>c.path),['src/impl.ts','src/end.ts','src/seed.ts']);assert.deepEqual(s.autoContext.candidates.map(c=>c.depth),[1,2]);assert.equal(s.autoContext.sourceBytes,s.context.reduce((n,c)=>n+c.bytes,0));
 const limited=await captureSnapshot(root,{...options,autoContext:true,maxContextFiles:1});assert.deepEqual(limited.context.map(c=>c.path),['src/seed.ts']);assert.equal(limited.autoContext.candidates[0].status,'blocked');
}));
test('explicit seed cannot restore excluded changes or read untracked descendants',()=>fixture(async({root,put})=>{
 await put('end.ts','export function changed(){}');const s=await captureSnapshot(root,{contextPaths:['src/seed.ts'],autoContext:true,selectedPaths:['src/change.ts']});assert.deepEqual(s.context.map(c=>c.path),['src/impl.ts','src/seed.ts']);
 await put('untracked.ts','export function hidden(){}');await put('seed.ts','export {hidden} from "./untracked";');const chain=await captureDependencyChain(root,[],{contextPaths:['src/seed.ts']});assert.equal(chain.context.length,0);assert.equal(chain.explicitSeeds.length,1);await assert.rejects(captureDependencyChain(root,[],{contextPaths:['src/seed.ts'],signal:AbortSignal.abort()}));
}));
test('explicit seed source and file caps remain hard limits',()=>fixture(async({root,put})=>{
 await put('huge.ts','x'.repeat(256*1024+1));await assert.rejects(captureDependencyChain(root,[],{contextPaths:['src/huge.ts'],maxFileBytes:1024*1024}),/File size/);
 await assert.rejects(captureDependencyChain(root,[],{contextPaths:['src/seed.ts','src/impl.ts'],maxContextFiles:1}),/Context file limit/);
 const names=[];for(let i=0;i<5;i++){names.push('src/large'+i+'.ts');await put('large'+i+'.ts','x'.repeat(220*1024));}await assert.rejects(captureDependencyChain(root,[],{contextPaths:names}),/source byte limit/);
}));
test('explicit seed approved preview has no source bodies and stale descendant stops sending',()=>fixture(async({root,put})=>{
 let sends=0;const exec={agent:{session:{header:{cwd:root}},options:{provider:'offline',model:'test'}},signal:new AbortController().signal};
 const service=createReviewService({async *stream(req){sends++;const p=JSON.parse(req.messages[0].content[0].text);for(const name of ['src/seed.ts','src/impl.ts','src/end.ts'])assert.ok(p.catalog.some(c=>c.path===name));yield {type:'text-delta',text:'{"findings":[],"limitations":[]}'};yield {type:'finish',reason:{kind:'stop'}};}},{allowModelSending:true,authorize:async()=>true});
 const options={autoContext:true,contextPaths:['src/seed.ts']},p=await service.preview(options,exec);assert.equal(sends,0);assert.ok(!JSON.stringify(p).includes('export function run'));await service.execute({previewId:p.previewId,confirmed:true},exec);assert.equal(sends,1);
 const next=await service.preview(options,exec);await put('end.ts','export function changed(){}');await assert.rejects(service.execute({previewId:next.previewId,confirmed:true},exec),/changed|outdated/i);assert.equal(sends,1);
}));
