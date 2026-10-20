import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {checked} from '../src/process.mjs';
import {xml} from '../src/svn.mjs';
import {captureReplacementTree} from '../src/svn-replacement-tree.mjs';
import {captureSnapshot} from '../src/snapshot.mjs';
import {svnCallerIndex} from '../src/svn-caller-index.mjs';

async function fixture(t,files){
 const base=await mkdtemp(path.join(os.tmpdir(),'dsh-audit-svn-'));
 t.after(async()=>{assert.ok(path.basename(base).startsWith('dsh-audit-svn-'));await rm(base,{recursive:true,force:true});});
 const repo=path.join(base,'repo'),root=path.join(base,'wc');
 await checked('svnadmin',['create',repo]);
 await checked('svn',['checkout','--non-interactive',pathToFileURL(repo).href,root]);
 const svn=(...args)=>checked('svn',['--non-interactive',...args],{cwd:root});
 for(const [name,body] of Object.entries(files)){await mkdir(path.dirname(path.join(root,name)),{recursive:true});await writeFile(path.join(root,name),body);}
 await svn('add','--force','--','.');await svn('commit','-m','baseline');
 const info=xml(await svn('info','--xml','--','.@')).info.entry[0];
 return {root,svn,info,tree:async(name,selectedPaths)=>captureReplacementTree(root,info,name,{svnReplacementBaseRevision:'1',selectedPaths})};
}
function blocked(tree,name){
 const f=tree.files.find(f=>f.path===name);assert.ok(f,name);assert.equal(f.eligibility,'blocked');assert.match(f.reason,/Credential replacement copy source/);assert.equal(f.left,undefined);assert.equal(f.right,undefined);
}

test('replacement file copied from credential URL cannot capture target bytes',async t=>{
 const f=await fixture(t,{'safe.js':'OLD','.env.private%name':'SECRET-DIRECT'});
 await f.svn('delete','safe.js');await f.svn('copy','.env.private%name','safe.js');
 const tree=await f.tree('safe.js',['safe.js']);blocked(tree,'safe.js');await tree.verify();
 assert.ok(!JSON.stringify(tree.files).includes('SECRET-DIRECT'));
 const snapshot=await captureSnapshot(f.root,{svnReplacementBaseRevision:'1',selectedPaths:['safe.js']});
 blocked(snapshot,'safe.js');assert.ok(!JSON.stringify(snapshot).includes('SECRET-DIRECT'));
});

test('credential copy descendant blocks replacement tree but preserves safe sibling',async t=>{
 const f=await fixture(t,{'d/old.js':'OLD','.env':'SECRET-DESCENDANT','normal.js':'NORMAL'});
 await f.svn('delete','d');await mkdir(path.join(f.root,'d'));await f.svn('add','d');
 await f.svn('copy','.env','d/copied.js');await f.svn('copy','normal.js','d/normal.js');
 const tree=await f.tree('d',['d','d/old.js','d/copied.js','d/normal.js']);
 blocked(tree,'d/copied.js');assert.equal(tree.files.find(x=>x.path==='d').eligibility,'blocked');
 assert.equal(tree.files.find(x=>x.path==='d/normal.js').right.text,'NORMAL');await tree.verify();
 assert.ok(!JSON.stringify(tree.files).includes('SECRET-DESCENDANT'));
});

test('copied credential ancestor is checked for selected descendants and nested replacement roots',async t=>{
 const f=await fixture(t,{'d/sub/a.js':'OLD','.ssh/sub/a.js':'SECRET-ANCESTOR'});
 await f.svn('delete','d');await f.svn('copy','.ssh','d');
 // The descendant can have no explicit copy-from-url; the copied ancestor must still deny it.
 const outer=await f.tree('d',['d','d/sub','d/sub/a.js']);
 for(const name of ['d','d/sub','d/sub/a.js'])blocked(outer,name);
 const nested=await f.tree('d/sub',['d/sub','d/sub/a.js']);
 for(const name of ['d/sub','d/sub/a.js'])blocked(nested,name);
 await outer.verify();await nested.verify();assert.ok(!JSON.stringify(nested.files).includes('SECRET-ANCESTOR'));
});

test('ordinary copied replacement trees retain independent fixed baseline and working bytes',async t=>{
 const f=await fixture(t,{'d/a.js':'OLD','source/a.js':'NEW','source/sub/b.js':'CHILD'});
 await f.svn('delete','d');await f.svn('copy','source','d');
 const tree=await f.tree('d',['d','d/a.js','d/sub','d/sub/b.js']);
 assert.ok(tree.files.every(x=>x.eligibility==='reviewable'));
 assert.equal(tree.files.find(x=>x.path==='d/a.js').left.text,'OLD');
 assert.equal(tree.files.find(x=>x.path==='d/a.js').right.text,'NEW');
 assert.equal(tree.files.find(x=>x.path==='d/sub/b.js').right.text,'CHILD');await tree.verify();
});

test('ordinary copied replacement files remain reviewable',async t=>{
 const f=await fixture(t,{'target.js':'OLD','source.js':'NEW'});
 await f.svn('delete','target.js');await f.svn('copy','source.js','target.js');
 const snapshot=await captureSnapshot(f.root,{svnReplacementBaseRevision:'1',selectedPaths:['target.js']});
 const target=snapshot.files.find(x=>x.path==='target.js');assert.equal(target.eligibility,'reviewable');
 assert.equal(target.left.text,'OLD');assert.equal(target.right.text,'NEW');
});

test('SVN caller scope ignores source-suffixed directories while scanning their real children',async t=>{
 const f=await fixture(t,{'api.js':'export default 1;','clients/folder.js/a.js':'import x from "../../api.js";','clients/negative.ts':'export default 0;'});
 await writeFile(path.join(f.root,'api.js'),'export default 2;');
 const before=xml(await f.svn('status','--xml'));
 const index=await svnCallerIndex(f.root,['clients']);
 assert.deepEqual(index.paths,['clients/folder.js/a.js','clients/negative.ts']);
 const snapshot=await captureSnapshot(f.root,{callerScopePaths:['clients']});
 assert.deepEqual(snapshot.callerDiscovery.scanned.map(x=>x.path),['clients/folder.js/a.js','clients/negative.ts']);
 assert.deepEqual(snapshot.context.map(x=>x.path),['clients/folder.js/a.js']);
 assert.deepEqual(xml(await f.svn('status','--xml')),before);
 // A local kind substitution cannot be accepted as the same index receipt.
 await rm(path.join(f.root,'clients/folder.js'),{recursive:true});await writeFile(path.join(f.root,'clients/folder.js'),'not a directory');
 const after=await svnCallerIndex(f.root,['clients']);assert.notEqual(after.fingerprint,index.fingerprint);
});
