import test from 'node:test';
import { reviewSnapshot } from '../src/review.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checked } from '../src/process.mjs';
import { captureSvn, xml } from '../src/svn.mjs';
import { captureSnapshot } from '../src/snapshot.mjs';
import { createReviewService } from '../src/service.mjs';
async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'dsh-review-svn-'));
  t.after(async () => { assert.ok(path.basename(base).startsWith('dsh-review-svn-')); await rm(base, { recursive: true, force: true }); });
  await checked('svnadmin', ['create', path.join(base, 'repo')]);
  const root = path.join(base, 'wc');
  await checked('svn', ['checkout', '--non-interactive', pathToFileURL(path.join(base, 'repo')).href, root]);
  const svn = (...args) => checked('svn', ['--non-interactive', ...args], { cwd: root });
  const put = (name, value) => writeFile(path.join(root, name), value);
  return { root, svn, put, repository: path.join(base, 'repo') };
}
test('SVN automatic context uses offline normal tracked nodes and cannot reintroduce modified or unversioned sources',async t=>{const {root,svn,put}=await fixture(t);await put('a.cpp','old');await put('dep.h','definition');await svn('add','--','a.cpp@','dep.h@');await svn('commit','-m','fixture');await put('a.cpp','#include \"dep.h\"\n#include \"untracked.h\"');await put('untracked.h','SECRET');const before=xml(await svn('status','--xml'));const s=await captureSnapshot(root,{autoContext:true,selectedPaths:['a.cpp']});assert.deepEqual(s.autoContext.capturedPaths,['dep.h']);assert.equal(s.context[0].text,'definition');assert.deepEqual(xml(await svn('status','--xml')),before);assert.equal(s.id,(await captureSnapshot(root,{autoContext:true,selectedPaths:['a.cpp']})).id);await put('dep.h','modified');assert.equal((await captureSnapshot(root,{autoContext:true,selectedPaths:['a.cpp']})).context.length,0);});
test('SVN explicit rules change snapshot identity without modifying working state', async t => {
  const { root, svn, put } = await fixture(t);
  await put('rules.md', 'Use bounded resources');
  await svn('add', '--', 'rules.md@'); await svn('commit', '-m', 'rules');
  const before = await svn('status', '--xml');
  const a = await captureSnapshot(root, { rulePaths: ['rules.md'] });
  assert.equal(a.rules[0].text, 'Use bounded resources');
  assert.deepEqual(xml(await svn('status', '--xml')), xml(before));
  await put('rules.md', 'Check cleanup');
  const modified = await svn('status', '--xml');
  const b = await captureSnapshot(root, { rulePaths: ['rules.md'] });
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.rules[0].hash, b.rules[0].hash);
  assert.deepEqual(xml(await svn('status', '--xml')), xml(modified));
  await svn('delete', '--force', '--', 'rules.md@');
  await assert.rejects(captureSnapshot(root, { rulePaths: ['rules.md'] }), /deleted/);
});
test('SVN captures BASE text, deletion, additions and directory properties without changes', async t => {
  const { root, svn, put } = await fixture(t);
  await put('中文 @ [].js', 'old\n'); await put('deleted', 'delete me'); await mkdir(path.join(root, 'dir'));
  await svn('add', '--', '中文 @ [].js@', 'deleted@', 'dir@'); await svn('commit', '-m', 'fixture');
  await put('中文 @ [].js', 'new\n'); await svn('delete', '--', 'deleted@');
  await put('-added', 'added'); await svn('add', '--', '-added@'); await put('untracked', 'secret');
  await svn('propset', 'review:test', 'changed', '--', 'dir@');
  const before = await svn('status', '--xml');
  const result = await captureSvn(root);
  const changed = result.files.find(f => f.path === '中文 @ [].js');
  assert.equal(changed.eligibility, 'reviewable', changed.reason);
  assert.equal(changed.left.text, 'old\n'); assert.equal(changed.right.text, 'new\n');
  assert.equal(result.files.find(f => f.path === 'deleted').right.text, '');
  assert.equal(result.files.find(f => f.path === 'deleted').rightExists, false);
  await assert.rejects(captureSnapshot(root, { contextPaths: ['deleted'] }), /Deleted path/);
  assert.equal(result.files.find(f => f.path === '-added').right.text, 'added');
  assert.deepEqual(result.files.find(f => f.path === 'dir').properties, [{ name: 'review:test', old: null, new: 'changed' }]);
  assert.equal(result.files.find(f => f.path === 'untracked').eligibility, 'excluded');
  const reviewed = [];
  const report = await reviewSnapshot(result, async request => {
    const { file, changes } = JSON.parse(request.input);
    reviewed.push(file.path);
    if (file.path === 'dir') {
      assert.equal(changes.status, 'unchanged');
      assert.equal(file.properties[0].name, 'review:test');
    } else {
      assert.equal(changes.status, 'changed');
      if (file.path === 'deleted') assert.equal(changes.edits[0].new.count, 0);
      if (file.path === '-added') assert.equal(changes.edits[0].old.count, 0);
    }
    return { findings: [], limitations: [] };
  });
  assert.equal(report.status, 'completed');
  assert.equal(reviewed.length, 4);
  assert.ok(!reviewed.includes('untracked'));
  assert.deepEqual(xml(await svn('status', '--xml')), xml(before));
  const selected = await captureSvn(root, { selectedPaths: ['untracked'] });
  assert.equal(selected.files.find(f => f.path === 'untracked').right.text, 'secret');
});
test('SVN missing source stays blocked while copied addition has empty target baseline', async t => {
  const { root, svn, put } = await fixture(t);
  await put('file', 'base'); await svn('add', 'file'); await svn('commit', '-m', 'fixture');
  await svn('copy', 'file', 'copied'); await rm(path.join(root, 'file'));
  const result = await captureSvn(root);
  assert.equal(result.files.length, 2);
  assert.equal(result.files.find(f => f.path === 'file').eligibility, 'blocked');
  const copy = result.files.find(f => f.path === 'copied');
  assert.equal(copy.eligibility, 'reviewable', copy.reason);
  assert.equal(copy.left.text, ''); assert.equal(copy.right.text, 'base');
  assert.equal(copy.copySource.revision, '1');
});
test('SVN copied addition and move retain independent target coverage offline', async t => {
  const {root,svn,put,repository}=await fixture(t);
  await put('a.js','SOURCE\n'); await put('b.js','MOVE\n');
  await svn('add','a.js','b.js');await svn('commit','-m','base');
  await svn('copy','a.js','copied.js');await put('copied.js','EDITED\n');
  await svn('move','b.js','moved.js');
  const before=xml(await svn('status','--xml'));
  await rename(repository,repository+'-offline');
  const snapshot=await captureSnapshot(root);
  for(const name of ['copied.js','moved.js']){
    const item=snapshot.files.find(f=>f.path===name);
    assert.equal(item.eligibility,'reviewable',item.reason);assert.equal(item.left.text,'');
    assert.equal(item.copySource.repositoryUuid,snapshot.repositoryUuid);
  }
  assert.equal(snapshot.files.find(f=>f.path==='copied.js').right.text,'EDITED\n');
  assert.equal(snapshot.files.find(f=>f.path==='b.js').rightExists,false);
  assert.equal(snapshot.id,(await captureSnapshot(root)).id);
  let sends=0;
  const service=createReviewService({stream:async function*(){sends++;}});
  try {
    const preview=await service.preview({}, {agent:{session:{header:{cwd:root}},options:{provider:'offline',model:'none'}}});
    assert.equal(preview.files.find(f=>f.path==='copied.js').copySource.revision,'1');
    assert.match(preview.files.find(f=>f.path==='copied.js').copyNotice,/empty target baseline/);
    assert.equal(sends,0);
  } finally {service.dispose();}
  assert.deepEqual(xml(await svn('status','--xml')),before);
});
test('SVN copied replacement never uses copy-source BASE as target old text', async t=>{
  const {root,svn,put}=await fixture(t);
  await put('source','SOURCE');await put('target','TARGET');await svn('add','source','target');await svn('commit','-m','base');
  await svn('delete','target');await svn('copy','source','target');
  const item=(await captureSvn(root)).files.find(f=>f.path==='target');
  assert.equal(item.eligibility,'blocked');assert.equal(item.left,undefined);assert.equal(item.right,undefined);
});
test('SVN copy from credential path does not acquire content authority', async t=>{
  const {root,svn,put}=await fixture(t);
  await put('.env','SECRET');await svn('add','.env');await svn('commit','-m','base');await svn('copy','.env','public.js');
  const item=(await captureSvn(root)).files.find(f=>f.path==='public.js');
  assert.equal(item.eligibility,'blocked');assert.equal(item.right,undefined);
});
test('SVN BASE capture works with repository offline', async t => {
  const { root, svn, put, repository } = await fixture(t);
  await put('file', 'base'); await svn('add', 'file'); await svn('commit', '-m', 'fixture');
  await put('file', 'modified');
  assert.equal(path.basename(repository), 'repo');
  assert.ok(path.basename(path.dirname(repository)).startsWith('dsh-review-svn-'));
  await rename(repository, repository + '-offline');
  const result = await captureSvn(root);
  assert.equal(result.files[0].eligibility, 'reviewable', result.files[0].reason);
  assert.equal(result.files[0].left.text, 'base');
});

test('SVN keyword expansion is explicitly blocked; CRLF working text is preserved', async t => {
  const { root, svn, put } = await fixture(t);
  await put('keywords', '$Id$'); await put('eol', 'old\n');
  await svn('add', 'keywords', 'eol'); await svn('propset', 'svn:keywords', 'Id', 'keywords');
  await svn('propset', 'svn:eol-style', 'CRLF', 'eol'); await svn('commit', '-m', 'fixture');
  await put('keywords', '$Id$ changed'); await put('eol', 'new\r\n');
  const result = await captureSvn(root);
  const keywords = result.files.find(f => f.path === 'keywords');
  assert.equal(keywords.eligibility, 'blocked'); assert.match(keywords.reason, /keyword/);
  const eol = result.files.find(f => f.path === 'eol');
  assert.equal(eol.eligibility, 'reviewable', eol.reason); assert.equal(eol.right.text, 'new\r\n');
});

test('XML rejects DTD and invalid structure', () => {
  assert.throws(() => xml(Buffer.from('<!DOCTYPE a><a/>')), /invalid|Unsafe/);
  assert.throws(() => xml(Buffer.from('<a>')), /invalid|Unsafe/);
});
