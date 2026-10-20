import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {checked} from '../src/process.mjs';
import {hash} from '../src/content.mjs';
import {svnKeywordMapping} from '../src/svn-keyword-mapping.mjs';
import {captureSvnExplicitContext} from '../src/svn-explicit-context.mjs';
import {svnCallerNode} from '../src/svn-caller-node.mjs';

async function fixture(t) {
 const dir=await mkdtemp(path.join(os.tmpdir(),'dsh-audit-svn-current-'));
 t.after(async()=>{assert.ok(path.basename(dir).startsWith('dsh-audit-svn-current-'));await rm(dir,{recursive:true,force:true});});
 const repo=path.join(dir,'repo'),root=path.join(dir,'wc');
 await checked('svnadmin',['create',repo]);
 await checked('svn',['checkout','--non-interactive',pathToFileURL(repo).href,root]);
 return {root,svn:(...args)=>checked('svn',['--non-interactive',...args],{cwd:root})};
}

const groups=[['Revision','Rev','LastChangedRevision'],['Date','LastChangedDate'],['Author','LastChangedBy'],['HeadURL','URL'],['Id'],['Header']];
test('alias overlap is allowed without enabling unrelated keywords or standard overrides',()=>{
 assert.equal(svnKeywordMapping('$Rev: 1 $ $LastChangedRevision: 1 $ $Author: untouched $','Revision Rev').text,'$Rev$ $LastChangedRevision$ $Author: untouched $');
 assert.throws(()=>svnKeywordMapping('x','Revision Revision'),/Duplicate/);
 assert.throws(()=>svnKeywordMapping('x','Revision Rev=%a'),/Unsupported/);
});
test('real SVN standard aliases contract every spelling enabled by each group member',async t=>{
 const {root,svn}=await fixture(t),cases=[];
 for(const group of groups)for(const keyword of group){
  const name=keyword+'.js',raw=group.map(alias=>'// $'+alias+'$').join('\r\n')+'\r\n// evidence\n';
  cases.push({name,keyword,raw});await writeFile(path.join(root,name),raw);await svn('add',name);await svn('propset','svn:keywords',keyword,name);
 }
 await svn('commit','-m','alias baseline','--username','ascii');
 for(const {name,keyword,raw} of cases){
  const working=await readFile(path.join(root,name),'utf8'),repository=(await svn('cat','--ignore-keywords','-r','BASE',name)).toString('utf8');
  for(const alias of groups.find(group=>group.includes(keyword)))assert.ok(working.includes('$'+alias+': '),keyword+' enables '+alias);
  const view=svnKeywordMapping(working,keyword);assert.equal(view.text,repository,keyword);assert.equal(repository,raw);
  assert.equal(view.rawTextHash,hash(working));assert.equal(view.lineMapping,'identity');assert.deepEqual(view.text.match(/\r?\n/g),working.match(/\r?\n/g));
 }
 const captured=await captureSvnExplicitContext(root,cases.map(item=>item.name));await captured.verify();
 for(const item of captured.context)assert.equal(item.text,await readFile(path.join(root,item.path),'utf8'));
});

for(const author of ['é','ascii'])test('real SVN fixed fields use UTF8 byte widths for standard and custom authors: '+author,async t=>{
 const {root,svn}=await fixture(t),name='fixed.js',configuration='Author Build=%a';
 const raw='// $Author::                    $\r\n// $Build::                    $\n// $Author::    $\n// $Build::    $\n// body\n';
 await writeFile(path.join(root,name),raw);await svn('add',name);await svn('propset','svn:keywords',configuration,name);await svn('commit','-m','fixed baseline','--username',author);
 // Four-byte narrow fields fit é exactly; ASCII author truncates with #.
 // Smaller fields can split UTF-8 bytes in native SVN and are not valid text.
 const workingBytes=await readFile(path.join(root,name)),working=new TextDecoder('utf-8',{fatal:true}).decode(workingBytes),repository=(await svn('cat','--ignore-keywords','-r','BASE',name)).toString('utf8');
 assert.ok(working.includes(author));if(author==='ascii')assert.ok(working.includes('#$'));
 const view=svnKeywordMapping(working,configuration);assert.equal(view.text,repository);assert.equal(repository,raw);assert.equal(view.fixedWidthFields,4);
 assert.equal(Buffer.byteLength(view.text),Buffer.byteLength(working));assert.equal(view.rawTextHash,hash(working));assert.equal(view.lineMapping,'identity');
 assert.deepEqual(view.text.match(/\r?\n/g),working.match(/\r?\n/g));
 const captured=await captureSvnExplicitContext(root,[name]);assert.equal(captured.context[0].text,working);assert.equal(captured.context[0].hash,hash(Buffer.from(working)));assert.equal(captured.context[0].keywordMapping.status,'verified-line-view');await captured.verify();
 assert.equal(await readFile(path.join(root,name),'utf8'),working);
});

test('explicit context verification shares its cumulative source cap without a navigation ledger',async t=>{
 const {root,svn}=await fixture(t),name='large.js';
 await writeFile(path.join(root,name),'//'+ 'a'.repeat(190000));await svn('add',name);await svn('commit','-m','large context');
 const captured=await captureSvnExplicitContext(root,[name]);assert.equal(captured.sourceBytes,190002);
 for(let i=0;i<4;i++)await captured.verify();
 await assert.rejects(captured.verify(),/source byte limit/);
});

test('explicit context revalidation rejects raw keyword body changes with identical SVN metadata',async t=>{
 const {root,svn}=await fixture(t),name='dep.js',filename=path.join(root,name);
 await writeFile(filename,'// $Rev$\nexport const value = 1;\n');await svn('add',name);await svn('propset','svn:keywords','Rev',name);await svn('commit','-m','context baseline');
 const captured=await captureSvnExplicitContext(root,[name]),identity=await svnCallerNode(root,name,{allowExplicitKeywords:true});
 const raw=await readFile(filename,'utf8');assert.ok(raw.includes('$Rev: 1 $'));
 // SVN contracts keyword values during status checks: altered raw evidence stays normal.
 await writeFile(filename,raw.replace('$Rev: 1 $','$Rev: 9 $'));
 assert.equal((await svnCallerNode(root,name,{allowExplicitKeywords:true})).fingerprint,identity.fingerprint,'reproduction requires identical metadata');
 await assert.rejects(captured.verify(),/content changed/i);
});
