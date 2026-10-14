import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {mergeSvnHistoryRecord} from '../src/svn-history.mjs';
import {checked} from '../src/process.mjs';import {captureSnapshot} from '../src/snapshot.mjs';

test('historical replacement summary accepts one add/delete pair and preserves both kinds',()=>{
 const add={'@_item':'added','@_kind':'file'},del={'@_item':'deleted','@_kind':'file'};
 for(const [left,right]of [[add,del],[del,add]])assert.equal(mergeSvnHistoryRecord(left,right)['@_item'],'replaced');
 const type=mergeSvnHistoryRecord(del,{...add,'@_kind':'dir'});assert.equal(type.oldKind,'file');assert.equal(type.newKind,'dir');assert.equal(type['@_kind'],'dir');
 for(const [left,right]of [[add,add],[del,del],[mergeSvnHistoryRecord(del,add),add],[del,{'@_item':'modified','@_kind':'file'}]])assert.throws(()=>mergeSvnHistoryRecord(left,right),/Ambiguous/);
});
test('fixed SVN history file-directory replacement binds each side and refuses incomplete descendant selection',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'dsh-hist-type-'));t.after(async()=>{assert.ok(path.basename(dir).startsWith('dsh-hist-type-'));await rm(dir,{recursive:true,force:true});});
 const repo=path.join(dir,'repo'),root=path.join(dir,'wc');await checked('svnadmin',['create',repo]);await checked('svn',['checkout',pathToFileURL(repo).href,root]);const svn=(...args)=>checked('svn',['--non-interactive',...args],{cwd:root});
 await writeFile(path.join(root,'file-to-dir'),'OLD FILE\n');await mkdir(path.join(root,'dir-to-file'));await writeFile(path.join(root,'dir-to-file/child.js'),'OLD CHILD\n');await svn('add','file-to-dir','dir-to-file');await svn('commit','-m','base');
 await svn('delete','file-to-dir','dir-to-file');await mkdir(path.join(root,'file-to-dir'));await writeFile(path.join(root,'file-to-dir/child.js'),'NEW CHILD\n');await writeFile(path.join(root,'dir-to-file'),'NEW FILE\n');await svn('add','file-to-dir','dir-to-file');await svn('commit','-m','replace types');
 const s=await captureSnapshot(root,{svnRevision:'2'});const fd=s.files.find(f=>f.path==='file-to-dir'),df=s.files.find(f=>f.path==='dir-to-file');
 assert.equal(fd.eligibility,'reviewable',fd.reason);assert.equal(fd.oldKind,'file');assert.equal(fd.newKind,'dir');assert.equal(fd.left.text,'OLD FILE\n');assert.equal(fd.right.text,'');assert.equal(fd.svnSources.old.kind,'file');
 assert.equal(df.eligibility,'reviewable',df.reason);assert.equal(df.oldKind,'dir');assert.equal(df.newKind,'file');assert.equal(df.left.text,'');assert.equal(df.right.text,'NEW FILE\n');
 assert.equal(s.files.find(f=>f.path==='dir-to-file/child.js').left.text,'OLD CHILD\n');assert.equal(s.files.find(f=>f.path==='file-to-dir/child.js').right.text,'NEW CHILD\n');
 const partial=await captureSnapshot(root,{svnRevision:'2',selectedPaths:['dir-to-file']});assert.equal(partial.files.find(f=>f.path==='dir-to-file').eligibility,'blocked');
 await assert.rejects(captureSnapshot(root,{svnRevision:'2',oldContextPaths:['dir-to-file']}),/baseline change/);
});
test('fixed SVN history replacement uses target old node, not copied source BASE',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'dsh-hist-replace-'));t.after(async()=>{assert.ok(path.basename(dir).startsWith('dsh-hist-replace-'));await rm(dir,{recursive:true,force:true});});
 const repo=path.join(dir,'repo'),root=path.join(dir,'wc');await checked('svnadmin',['create',repo]);await checked('svn',['checkout',pathToFileURL(repo).href,root]);const svn=(...args)=>checked('svn',['--non-interactive',...args],{cwd:root});
 for(const [name,text]of [['ordinary.js','TARGET OLD\n'],['copied.js','COPY TARGET OLD\n'],['source.js','SOURCE\n']])await writeFile(path.join(root,name),text);
 await svn('add','ordinary.js','copied.js','source.js');await svn('propset','review:old','target-old','copied.js');await svn('commit','-m','base');
 await svn('delete','ordinary.js');await writeFile(path.join(root,'ordinary.js'),'TARGET NEW\n');await svn('add','ordinary.js');
 await svn('delete','copied.js');await svn('copy','source.js','copied.js');await svn('propset','review:new','target-new','copied.js');await svn('commit','-m','replace');
 const s=await captureSnapshot(root,{svnRevision:'2'});
 const ordinary=s.files.find(f=>f.path==='ordinary.js'),copy=s.files.find(f=>f.path==='copied.js');
 assert.equal(ordinary.eligibility,'reviewable',ordinary.reason);assert.equal(ordinary.left.text,'TARGET OLD\n');assert.equal(ordinary.right.text,'TARGET NEW\n');
 assert.equal(copy.rawStatus,'replaced');assert.equal(ordinary.rawStatus,'replaced');assert.equal(copy.eligibility,'reviewable',copy.reason);assert.equal(copy.left.text,'COPY TARGET OLD\n');assert.equal(copy.right.text,'SOURCE\n');
 assert.ok(copy.properties.some(p=>p.name==='review:old'&&p.old==='target-old'&&p.new===null));assert.ok(copy.properties.some(p=>p.name==='review:new'&&p.new==='target-new'));
 assert.equal(copy.svnSources.old.operativeRevision,'1');assert.equal(copy.svnSources.new.operativeRevision,'2');assert.ok(copy.svnSources.old.url.endsWith('/copied.js'));
});
