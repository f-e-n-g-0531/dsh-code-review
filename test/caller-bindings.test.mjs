import { reviewSnapshot } from '../src/review.mjs';
import { captureCallers } from '../src/caller-capture.mjs';
import { checked } from '../src/process.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const bindings=[{imported:'x',local:'alias',importLine:1,callLine:2,declarationLine:1,declarationKind:'function',confidence:'conservative-syntax-only'}];
const snapshot=()=>({id:'callers',vcs:'git',files:[{id:'f',path:'src/dep.ts',eligibility:'reviewable',properties:[],left:{text:''},right:{text:'export function x(value) {}'}}],context:[{path:'app/a.ts',text:"import { x as alias } from '../src/dep';"+String.fromCharCode(10)+'alias();'}],callerDiscovery:{scopes:['app'],scannedBytes:0,scanned:[],skipped:[],candidates:[{fromPath:'app/a.ts',targetPath:'src/dep.ts',reason:'literal-relative-import',confidence:'navigation-only',bindings}],capturedPaths:['app/a.ts'],incomplete:true,limitations:[]}});
test('approved caller call sites reach review input while unapproved callers never do',async()=>{
 let sends=0;
 await reviewSnapshot(snapshot(),async request=>{const p=JSON.parse(request.input);assert.equal(p.callerBindings[0].fromPath,'app/a.ts');assert.equal(p.callerBindings[0].bindings[0].callLine,2);assert.match(p.callerBindingNotice,/不证明执行可达/);sends++;return {findings:[],limitations:[]};});
 assert.equal(sends,1);
 const orphan=snapshot();orphan.context=[];
 await reviewSnapshot(orphan,async request=>{assert.equal(JSON.parse(request.input).callerBindings,undefined);return {findings:[],limitations:[]};});
 const unrelated=snapshot();unrelated.callerDiscovery.candidates[0].targetPath='src/other.ts';
 await reviewSnapshot(unrelated,async request=>{assert.equal(JSON.parse(request.input).callerBindings,undefined);return {findings:[],limitations:[]};});
});
test('real tracked caller bodies bind the changed declaration without extra reads',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'dsh-caller-bind-'));
 t.after(async()=>{assert.ok(path.basename(root).startsWith('dsh-caller-bind-'));await rm(root,{recursive:true,force:true});});
 const git=(...args)=>checked('git',args,{cwd:root});
 await git('init');await mkdir(path.join(root,'src'));await mkdir(path.join(root,'app'));
 await writeFile(path.join(root,'src','dep.ts'),'export function run(value) { return value; }');
 await writeFile(path.join(root,'app','a.ts'),"import { run as execute } from '../src/dep';"+String.fromCharCode(10)+'execute(1);');
 await git('add','--','src/dep.ts','app/a.ts');await git('-c','user.email=a@b.c','-c','user.name=t','commit','-m','fixture');
 await writeFile(path.join(root,'src','dep.ts'),'export function run(value) { return value + 1; }');
 const files=[{id:'f',path:'src/dep.ts',eligibility:'reviewable',properties:[],left:{text:'export function run(value) { return value; }'},right:{text:'export function run(value) { return value + 1; }'}}];
 const captured=await captureCallers(root,files,['app']);
 assert.deepEqual(captured.discovery.candidates.map(c=>({fromPath:c.fromPath,targetPath:c.targetPath,bindings:c.bindings})),[{fromPath:'app/a.ts',targetPath:'src/dep.ts',bindings:[{imported:'run',local:'execute',importLine:1,callLine:2,declarationLine:1,declarationKind:'function',confidence:'conservative-syntax-only'}]}]);
 assert.deepEqual(captured.context.map(c=>c.path),['app/a.ts']);
});
test('historical reviews never bind current-side caller call sites',async()=>{
 const historical=snapshot();historical.history={base:'a'.repeat(40),target:'b'.repeat(40)};
 let sends=0;
 await reviewSnapshot(historical,async request=>{assert.equal(JSON.parse(request.input).callerBindings,undefined);sends++;return {findings:[],limitations:[]};});
 assert.equal(sends,1);
});
