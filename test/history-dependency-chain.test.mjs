import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createReviewService} from '../src/service.mjs';
import {measureSnapshotCapture,snapshotCapturePhase} from '../src/snapshot-capture-metrics.mjs';
import {checked} from '../src/process.mjs';import {captureSnapshot} from '../src/snapshot.mjs';import {captureHistoryDependencyChain} from '../src/history-dependency-chain.mjs';import {createRetrievalScope} from '../src/retrieval-scope.mjs';
async function fixture(fn){const root=await mkdtemp(path.join(os.tmpdir(),'dsh-history-chain-'));try{const git=(...a)=>checked('git',a,{cwd:root}),put=(n,t)=>writeFile(path.join(root,n),t);await git('init','-q');await git('config','user.email','test@example.invalid');await git('config','user.name','Test');
 for(const [n,v] of [['main.ts','import x from "./oldbarrel";'],['oldbarrel.ts','export {x} from "./oldimpl";'],['oldimpl.ts','export {x} from "./oldend";'],['oldend.ts','export {x} from "./oldbeyond";'],['oldbeyond.ts','export const x=1;'],['newbarrel.ts','export {x} from "./newimpl";'],['newimpl.ts','export {x} from "./newend";'],['newend.ts','export {x} from "./newbeyond";'],['newbeyond.ts','export const x=2;']])await put(n,v);
 await git('add','.');await git('commit','-qm','base');await put('main.ts','import x from "./newbarrel";');await git('commit','-qam','target');await fn({root,git,put});
 }finally{assert.ok(path.basename(root).startsWith('dsh-history-chain-'));await rm(root,{recursive:true,force:true});}}
test('historical chains capture three layers on each side without worktree or fourth-layer authority',()=>fixture(async({root,put,git})=>{
 await put('oldimpl.ts','DIRTY SECRET');const status=await git('status','--porcelain');const s=await captureSnapshot(root,{commit:'HEAD',autoContext:true});assert.deepEqual(s.autoContext.capturedPaths,['newbarrel.ts','newend.ts','newimpl.ts','oldbarrel.ts','oldend.ts','oldimpl.ts']);assert.equal(s.autoContext.truncated,true);assert.equal(s.files.length,1);assert.ok(!JSON.stringify(s).includes('DIRTY SECRET'));assert.ok(!s.context.some(c=>c.path.includes('beyond')));assert.equal(s.id,(await captureSnapshot(root,{commit:'HEAD',autoContext:true})).id);assert.deepEqual(await git('status','--porcelain'),status);
}));
test('old-only seed stays old-only while chain avoids cycles and respects context slots',()=>fixture(async({root,git,put})=>{
 await put('oldimpl.ts','export {x} from "./oldbarrel";');await git('add','oldimpl.ts');await git('commit','-qm','cycle');
 const s=await captureSnapshot(root,{baseRevision:'HEAD~2',targetRevision:'HEAD',selectedPaths:['main.ts'],autoContext:true,oldContextPaths:['oldbarrel.ts'],maxContextFiles:3});const seed=s.context.find(c=>c.path==='oldbarrel.ts');assert.equal(seed.oldOnly,true);assert.equal(seed.text,undefined);assert.ok(s.autoContext.candidates.some(c=>c.status==='blocked'));assert.equal(s.context.length,3);const catalog=createRetrievalScope(s).catalog();assert.ok(catalog.some(c=>c.path==='oldbarrel.ts'&&c.side==='context-old'));assert.ok(!catalog.some(c=>c.path==='oldbarrel.ts'&&c.side==='context-new'));
}));
test('historical cycle is deduplicated independently on both sides',()=>fixture(async({root,git,put})=>{
 await put('oldimpl.ts','export {x} from "./oldbarrel";');await put('newimpl.ts','export {x} from "./newbarrel";');await git('add','.');await git('commit','-qm','cycles');await put('main.ts','import x from "./oldbarrel";');await git('commit','-qam','cycle target');const s=await captureSnapshot(root,{commit:'HEAD',autoContext:true});assert.equal(s.autoContext.truncated,false);assert.equal(s.context.length,4);assert.equal(new Set(s.context.map(c=>c.path)).size,4);
}));
test('historical approved chain reaches model but moving HEAD refuses before subsequent send',()=>fixture(async({root,git,put})=>{
 let sends=0;const exec={agent:{session:{header:{cwd:root}},options:{provider:'offline',model:'test'}},signal:new AbortController().signal};
 const service=createReviewService({async *stream(req){sends++;const p=JSON.parse(req.messages[0].content[0].text);assert.ok(p.catalog.some(c=>c.path==='newimpl.ts'));assert.ok(p.catalog.some(c=>c.path==='oldimpl.ts'));assert.ok(!p.catalog.some(c=>c.path==='newbeyond.ts'));yield {type:'text-delta',text:'{"findings":[],"limitations":[]}'};yield {type:'finish',reason:{kind:'stop'}};}},{allowModelSending:true,authorize:async()=>true});
 const options={commit:'HEAD',autoContext:true},preview=await service.preview(options,exec);assert.equal(sends,0);assert.ok(!JSON.stringify(preview).includes('export {x}'));await service.execute({previewId:preview.previewId,confirmed:true},exec);assert.equal(sends,1);
 const next=await service.preview(options,exec);await put('main.ts','export const changed=3;');await git('commit','-qam','move');await assert.rejects(service.execute({previewId:next.previewId,confirmed:true},exec),/changed|outdated/i);assert.equal(sends,1);
}));
test('historical chain shares probe and two-side source limits and refuses cancellation',()=>fixture(async({root,git})=>{
 const target=(await git('rev-parse','HEAD')).toString().trim(),base=(await git('rev-parse','HEAD~1')).toString().trim(),files=[{path:'main.ts',eligibility:'reviewable',right:{text:Array.from({length:40},(_,i)=>'import x from "./dep'+i+'";').join(String.fromCharCode(10))}}];await assert.rejects(captureHistoryDependencyChain(root,files,{base,target},[]),/lookup limit/);
 const context=Array.from({length:3},(_,i)=>({path:'seed'+i+'.ts',text:'x'.repeat(200*1024),oldText:'x'.repeat(200*1024)}));await assert.rejects(captureHistoryDependencyChain(root,[],{base,target},context),/source byte limit/);await assert.rejects(captureHistoryDependencyChain(root,[],{base,target},[],{signal:AbortSignal.abort()}));
}));

test('historical dependency frontier batches both sides and caches absent candidates',()=>fixture(async({root,git,put})=>{
 const names=Array.from({length:12},(_,i)=>'dep-'+String(i).padStart(2,'0')+'.ts');
 for(const [i,name]of names.entries())await put(name,JSON.stringify('old '+i));
 await git('add','--all');await git('commit','-qm','deps');
 const base=(await git('rev-parse','HEAD')).toString().trim();
 await git('rm',names[0]);await put(names[1],JSON.stringify('new 1'));
 await git('commit','-qam','new deps');
 const target=(await git('rev-parse','HEAD')).toString().trim();
 for(const name of names.slice(1))await put(name,'DIRTY');
 const text=names.map(name=>'import "./'+name+'";').concat('import "./missing.ts";').join('\n');
 const files=[{path:'entry.ts',eligibility:'reviewable',left:{text},right:{text}}];
 const context=[];
 const {snapshot:chain,metrics}=await measureSnapshotCapture(()=>snapshotCapturePhase('dependencies',()=>captureHistoryDependencyChain(root,files,{base,target},context)));
 assert.deepEqual(chain.capturedPaths,names);
 assert.equal(chain.probeCount,13);
 // Eleven old counterparts retain candidate-local failure isolation.
 assert.equal(metrics.phases.dependencies.treeQueries,13);
 for(const [i,name]of names.entries()){
  const value=context.find(entry=>entry.path===name);
  assert.equal(value.oldText,JSON.stringify('old '+i));assert.equal(value.oldRevision,base);
  assert.equal(value.text,i===0?undefined:JSON.stringify(i===1?'new 1':'old '+i));
  assert.equal(value.revision,i===0?undefined:target);
 }
 assert.equal(context.find(entry=>entry.path===names[0]).oldOnly,true);
 assert.equal(JSON.stringify(context).includes('DIRTY'),false);
}));
