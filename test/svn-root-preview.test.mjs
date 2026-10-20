import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checked } from '../src/process.mjs';
import { captureSnapshot } from '../src/snapshot.mjs';
import { xml } from '../src/svn.mjs';
import { createReviewService } from '../src/service.mjs';
import { inferFileRelations } from '../src/file-relations.mjs';

test('relation root exception requires directory identity and never permits traversal',()=>{
 const file={id:'root',path:'.',kind:'dir',eligibility:'excluded'};
 assert.deepEqual(inferFileRelations([file]),[]);
 for(const change of [{kind:'file'},{kind:undefined},{path:'./a.js'},{path:'a/../b.js'}])assert.throws(()=>inferFileRelations([{...file,...change}]));
});

test('SVN root mergeinfo and three source changes preview without model sends', async t => {
 const dir=await mkdtemp(path.join(os.tmpdir(),'dsh-root-preview-'));
 t.after(async()=>{assert.ok(path.basename(dir).startsWith('dsh-root-preview-'));await rm(dir,{recursive:true,force:true});});
 const repo=path.join(dir,'repo'),root=path.join(dir,'wc');
 await checked('svnadmin',['create',repo]);
 await checked('svn',['checkout','--non-interactive',pathToFileURL(repo).href,root]);
 const svn=(...args)=>checked('svn',['--non-interactive',...args],{cwd:root});
 for(const name of ['a.js','b.cpp','c.cs'])await writeFile(path.join(root,name),'old\n');
 await svn('add','a.js','b.cpp','c.cs');await svn('commit','-m','base');
 for(const name of ['a.js','b.cpp','c.cs'])await writeFile(path.join(root,name),'new\n');
 await svn('propset','svn:mergeinfo','/branches/release:1','.');
 const before=await svn('status','--xml');
 const snapshot=await captureSnapshot(root);
 assert.ok(snapshot.files.some(f=>f.path==='.' && f.kind==='dir'));
 let sends=0;
 const service=createReviewService({stream:async function*(){sends++;}});
 const exec={agent:{session:{header:{cwd:root}},options:{provider:'offline',model:'none'}}};
 try{
  for(const args of [{},{selectedPaths:['a.js','b.cpp','c.cs']}]){
   const preview=await service.preview(args,exec);
   assert.equal(preview.vcs,'svn');
   assert.equal(preview.files.length,4);
   assert.equal(preview.files.find(f=>f.path==='.').eligibility,args.selectedPaths?'excluded':'reviewable');
  }
  assert.equal(sends,0);assert.deepEqual(xml(await svn('status','--xml')),xml(before));
 }finally{service.dispose();}
});
