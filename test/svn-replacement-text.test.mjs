import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rename,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {checked} from '../src/process.mjs';
import {replacementTextCandidate} from '../src/svn-replacement-text.mjs';

const patch=(body='-OLD\n+NEW\n',hunk='@@ -1 +1 @@')=>'Index: a.txt\n'+'='.repeat(67)+'\n--- a.txt\t(revision 1)\n+++ a.txt\t(working copy)\n'+hunk+'\n'+body;
test('replacement text candidate remains explicitly unapproved and preserves EOF',()=>{
 const result=replacementTextCandidate(patch(),'a.txt','NEW\n');
 assert.equal(result.oldText,'OLD\n');assert.equal(result.status,'candidate-only');assert.equal(result.oldRevision,'1');
 const eof=patch('-OLD\n\\ No newline at end of file\n+NEW\n\\ No newline at end of file\n');
 assert.equal(replacementTextCandidate(eof,'a.txt','NEW').oldText,'OLD');
 const empty=patch('-OLD\n','@@ -1 +0,0 @@');assert.equal(replacementTextCandidate(empty,'a.txt','').newText,'');
});
test('replacement candidate rejects partial, wrong scope, malformed and over-budget diffs',()=>{
 for(const input of [patch().replace('Index: a.txt','Index: b.txt'),patch().replace('(revision 1)','(nonexistent)'),patch('Binary files differ\n'),patch('-OLD\n','@@ -1 +1 @@'),patch('-OLD\n+NEW\n','@@ -2 +2 @@'),patch()+'Index: b.txt\n',patch('\\ No newline at end of file\n-OLD\n+NEW\n')])assert.throws(()=>replacementTextCandidate(input,'a.txt','NEW\n'));
 assert.throws(()=>replacementTextCandidate(patch().trimEnd(),'a.txt','NEW\n'),/truncated/);
 assert.throws(()=>replacementTextCandidate(patch(),'a.txt','NEW\nextra\n'),/complete working/);
 assert.throws(()=>replacementTextCandidate(patch(),'a.txt','NEW\n',{maxBytes:2}),/limit/);
 assert.throws(()=>replacementTextCandidate(patch(),'../a.txt','NEW\n'),/Unsafe/);
});
test('offline SVN diff exposes target old text for ordinary and copied replacements but cat BASE does not',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'dsh-replace-text-'));
 t.after(async()=>{assert.ok(path.basename(dir).startsWith('dsh-replace-text-'));await rm(dir,{recursive:true,force:true});});
 const repo=path.join(dir,'repo'),wc=path.join(dir,'wc');await checked('svnadmin',['create',repo]);await checked('svn',['checkout',pathToFileURL(repo).href,wc]);
 const svn=(...args)=>checked('svn',['--non-interactive',...args],{cwd:wc});
 for(const [name,text]of [['a.txt','TARGET OLD\n'],['b.txt','OTHER OLD\n'],['source.txt','SOURCE\n']])await writeFile(path.join(wc,name),text);
 await svn('add','a.txt','b.txt','source.txt');await svn('propset','review:old','old','a.txt');await svn('commit','-m','base');
 await svn('delete','a.txt');await writeFile(path.join(wc,'a.txt'),'NEW\n');await svn('add','a.txt');
 await svn('delete','b.txt');await svn('copy','source.txt','b.txt');await rename(repo,repo+'-offline');
 await assert.rejects(svn('cat','-r','BASE','a.txt@'));
 assert.equal((await svn('cat','-r','BASE','b.txt@')).toString('utf8'),'SOURCE\n');
 for(const [name,working,old]of [['a.txt','NEW\n','TARGET OLD\n'],['b.txt','SOURCE\n','OTHER OLD\n']]){
  const diff=(await svn('diff','--internal-diff','--ignore-properties','-x','-U100000','--',name)).toString('utf8');
  const candidate=replacementTextCandidate(diff,name,working);
  assert.equal(candidate.oldText,old);assert.equal(candidate.status,'candidate-only');
 }
 const props=(await svn('proplist','--xml','--verbose','-r','BASE','a.txt@')).toString('utf8');
 assert.ok(!props.includes('review:old')); // Text reconstruction cannot authorize missing old properties.
});
