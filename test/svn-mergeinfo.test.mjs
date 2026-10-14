import test from 'node:test';import assert from 'node:assert/strict';
import {mergeinfoNavigation} from '../src/svn-mergeinfo.mjs';
import {mkdtemp,writeFile,rm}from'node:fs/promises';import os from'node:os';import path from'node:path';import{pathToFileURL}from'node:url';import{checked}from'../src/process.mjs';import{captureSnapshot}from'../src/snapshot.mjs';import{createReviewService}from'../src/service.mjs';

test('mergeinfo navigation preserves non-inheritable ranges without expanding large histories',()=>{
 const value=mergeinfoNavigation('/branches/release:1-9000000000,9000000001*\n/trunk:2-3\n');
 assert.equal(value.status,'parsed');assert.equal(value.sources.length,2);assert.deepEqual(value.sources[0].ranges,[{start:'1',end:'9000000000',inheritable:true},{start:'9000000001',end:'9000000001',inheritable:false}]);assert.match(value.notice,/not effective inherited/);
 assert.equal(mergeinfoNavigation(null).sources.length,0);
});
test('malformed or oversized mergeinfo is disclosed with no partial navigation',()=>{
 for(const text of ['/branch:2-1','/branch:0','/branch:HEAD','/../escape:1','/branch:1\n/branch:2','/branch:1,','/branch\\escape:1']){const r=mergeinfoNavigation(text);assert.equal(r.status,'invalid');assert.deepEqual(r.sources,[]);}
 assert.equal(mergeinfoNavigation('x'.repeat(16385)).status,'limited');
 assert.equal(mergeinfoNavigation('/branch:'+Array(501).fill('1').join(',')).status,'limited');
});
test('fixed history mergeinfo navigation is preview metadata, excludes unapproved changes and sends no model request',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'dsh-merge-nav-'));t.after(async()=>{assert.ok(path.basename(dir).startsWith('dsh-merge-nav-'));await rm(dir,{recursive:true,force:true});});
 const repo=path.join(dir,'repo'),root=path.join(dir,'wc');await checked('svnadmin',['create',repo]);await checked('svn',['checkout',pathToFileURL(repo).href,root]);const svn=(...args)=>checked('svn',['--non-interactive',...args],{cwd:root});
 await writeFile(path.join(root,'a.js'),'ONE\n');await svn('add','a.js');await svn('commit','-m','base');await svn('update');await writeFile(path.join(root,'a.js'),'TWO\n');await svn('propset','svn:mergeinfo','/branches/release:1*','.');await svn('commit','-m','merge property');
 const s=await captureSnapshot(root,{svnRevision:'2'});assert.equal(s.history.mergeSources.length,1);assert.equal(s.history.mergeSources[0].path,'.');assert.equal(s.history.mergeSources[0].new.sources[0].sourcePath,'/branches/release');
 const selected=await captureSnapshot(root,{svnRevision:'2',selectedPaths:['a.js']});assert.equal(selected.history.mergeSources,undefined);
 let calls=0;const service=createReviewService({stream:async function*(){calls++;}});try{const p=await service.preview({svnRevision:'2'},{agent:{session:{header:{cwd:root}},options:{provider:'offline',model:'none'}}});assert.equal(p.history.mergeSources[0].new.sources[0].ranges[0].inheritable,false);assert.equal(calls,0);}finally{service.dispose();}
});
