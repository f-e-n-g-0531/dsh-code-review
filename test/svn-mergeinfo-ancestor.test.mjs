import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,rename}from'node:fs/promises';import os from'node:os';import path from'node:path';import{pathToFileURL}from'node:url';import{checked}from'../src/process.mjs';import{captureSnapshot}from'../src/snapshot.mjs';import{mergeinfoOnlyAncestorProperties,svnCallerAncestors}from'../src/svn-caller-safety.mjs';
import {contextCandidates}from'../src/context-candidates.mjs';import{callerCandidates}from'../src/caller-candidates.mjs';
test('root node navigation exception requires directory identity and never permits traversal',()=>{
 const root={path:'.',kind:'dir',eligibility:'excluded'};assert.deepEqual(contextCandidates([root],[]).candidates,[]);assert.deepEqual(callerCandidates([root],[],[]).candidates,[]);
 for(const change of [{kind:'file'},{kind:undefined},{path:'./a.js'},{path:'../a.js'}]){assert.throws(()=>contextCandidates([{...root,...change}],[]));assert.throws(()=>callerCandidates([{...root,...change}],[],[]));}
});
const prop=(name,text)=>({'@_name':name,'#text':text});
test('ancestor exception permits only mergeinfo differences and rejects externals special or malformed properties',()=>{
 assert.doesNotThrow(()=>mergeinfoOnlyAncestorProperties([prop('review:p','same')],[prop('review:p','same'),prop('svn:mergeinfo','/branch:1')]));
 for(const [old,current]of [[[],[prop('review:p','new')]],[[prop('svn:externals','old')],[]],[[],[prop('svn:special','*')]],[[prop('x','a'),prop('x','a')],[]],[[{'@_name':'x','@_encoding':'base64','#text':'a'}],[]]])assert.throws(()=>mergeinfoOnlyAncestorProperties(old,current),/Unsafe/);
});
test('mergeinfo-only root ancestor allows offline dependency capture but remains fingerprinted and rejects other changes',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'dsh-merge-ancestor-'));t.after(async()=>{assert.ok(path.basename(dir).startsWith('dsh-merge-ancestor-'));await rm(dir,{recursive:true,force:true});});const repo=path.join(dir,'repo'),root=path.join(dir,'wc');await checked('svnadmin',['create',repo]);await checked('svn',['checkout',pathToFileURL(repo).href,root]);const svn=(...a)=>checked('svn',['--non-interactive',...a],{cwd:root});
 await mkdir(path.join(root,'lib'));await mkdir(path.join(root,'clients'));await writeFile(path.join(root,'target.js'),'old\n');await writeFile(path.join(root,'clients/use.js'),'import "../target.js";\n');await writeFile(path.join(root,'main.cpp'),'old\n');await writeFile(path.join(root,'lib/dep.h'),'definition\n');await svn('add','main.cpp','lib','target.js','clients');await svn('commit','-m','base');await writeFile(path.join(root,'main.cpp'),'#include "lib/dep.h"\n');await writeFile(path.join(root,'target.js'),'new\n');await svn('propset','svn:mergeinfo','/branch:1','.');await rename(repo,repo+'-offline');
 const first=await svnCallerAncestors(root,'lib');const s=await captureSnapshot(root,{selectedPaths:['main.cpp'],autoContext:true});assert.deepEqual(s.autoContext.capturedPaths,['lib/dep.h']);assert.equal(s.context[0].text,'definition\n');
 const callers=await captureSnapshot(root,{selectedPaths:['target.js'],callerScopePaths:['clients']});assert.ok(callers.context.some(c=>c.path==='clients/use.js'));
 await svn('propset','svn:mergeinfo','/branch:1-2','.');const second=await svnCallerAncestors(root,'lib');assert.notEqual(first.fingerprint,second.fingerprint);
 await svn('propset','review:other','changed','.');await assert.rejects(svnCallerAncestors(root,'lib'),/property change/);
});
