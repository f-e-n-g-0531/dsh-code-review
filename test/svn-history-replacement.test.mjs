import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {mergeSvnHistoryRecord} from '../src/svn-history.mjs';
import {checked} from '../src/process.mjs';import {captureSnapshot} from '../src/snapshot.mjs';

test('historical replacement summary accepts only one same-kind add/delete pair',()=>{
 const add={'@_item':'added','@_kind':'file'},del={'@_item':'deleted','@_kind':'file'};
 for(const [left,right]of [[add,del],[del,add]])assert.equal(mergeSvnHistoryRecord(left,right)['@_item'],'replaced');
 for(const [left,right]of [[add,add],[del,del],[del,{...add,'@_kind':'dir'}],[mergeSvnHistoryRecord(del,add),add],[del,{'@_item':'modified','@_kind':'file'}]])assert.throws(()=>mergeSvnHistoryRecord(left,right),/Ambiguous/);
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
