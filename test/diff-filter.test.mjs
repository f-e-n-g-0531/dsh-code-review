import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Config } from '../index.mjs';
import { checked } from '../src/process.mjs';
import { diffFilter } from '../src/diff-filter.mjs';
import { captureSnapshotWithMetrics } from '../src/snapshot.mjs';
import { createReviewService } from '../src/service.mjs';

async function fixture(t) {
  const prefix = 'dsh-diff-filter-';
  const base = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => { assert.ok(path.basename(base).startsWith(prefix)); await rm(base,{recursive:true,force:true}); });
  return base;
}
const full = { autoExcludeNonCode: false, diffExcludeFolderNames: '' };
const paths = ['image.PNG', 'nested/tEsT/check.cpp', 'testimony/keep.shader'];
async function put(root, text) {
  for (const name of paths) {
    await mkdir(path.dirname(path.join(root,name)), { recursive:true });
    await writeFile(path.join(root,name), text);
  }
}
const eligibility = snapshot => Object.fromEntries(snapshot.files.filter(file=>paths.includes(file.path)).map(file=>[file.path,file.eligibility]));
const expected = { [paths[0]]:'excluded', [paths[1]]:'excluded', [paths[2]]:'reviewable' };

function assertFiltered(result, unfiltered, phase) {
  assert.deepEqual(eligibility(result.snapshot), expected);
  assert.deepEqual(Object.values(eligibility(unfiltered.snapshot)), ['reviewable','reviewable','reviewable']);
  for (const file of result.snapshot.files.filter(file=>file.eligibility==='excluded')) {
    assert.ok(!file.left && !file.right);
    assert.match(file.reason, /^Filtered /);
  }
  assert.ok(result.metrics.phases[phase].sourceStdoutBytes < unfiltered.metrics.phases[phase].sourceStdoutBytes);
  assert.notEqual(result.snapshot.id, unfiltered.snapshot.id);
}

test('default config, token boundaries and overrides', () => {
  const config = Config({ reviewEffort:'deep' });
  assert.equal(config.autoExcludeNonCode.get(),true);
  assert.equal(config.diffExcludeFolderNames.get(),'Test');
  assert.equal(config.reviewEffort,'deep');
  for (const name of ['a/.github/ci.yml','test','Tests/a.cpp','sample.png/shape.shader','assets/unknown.x','gfx.shader']) assert.equal(diffFilter().reason(name),undefined);
  assert.match(diffFilter().reason('a/TeSt','dir'), /Filtered folder/);
  assert.equal(diffFilter().reason('a.png','dir'),undefined);
  assert.match(diffFilter({diffExcludeSuffixes:'.foo，BAR'}).reason('a.BAR'), /[.]bar/);
  assert.throws(()=>diffFilter({diffExcludeFolderNames:'a/b'}), /diffExcludeFolderNames/);
  assert.throws(()=>diffFilter({diffExcludeSuffixes:'*.jpg'}), /diffExcludeSuffixes/);
});

test('Git skips filtered blobs in worktree, staged and fixed history; preview discloses exclusions', async t => {
  const root = await fixture(t);
  const git = (...args) => checked('git',args,{cwd:root});
  await git('init','-q'); await git('config','user.name','Fixture'); await git('config','user.email','fixture@example.invalid');
  await put(root,'before\n'); await git('add','.'); await git('commit','-qm','base');
  await put(root,'after\n'); await git('add','.');
  for (const options of [{},{changeScope:'staged'}]) {
    assertFiltered(await captureSnapshotWithMetrics(root,options), await captureSnapshotWithMetrics(root,{...options,...full}), 'working-capture');
  }
  await git('commit','-qm','change');
  const options = {commit:'HEAD'};
  assertFiltered(await captureSnapshotWithMetrics(root,options), await captureSnapshotWithMetrics(root,{...options,...full}), 'git-history');
  let settings = {};
  const service = createReviewService({}, {resolveCwd: async()=>root,getDiffFilterOptions:()=>settings});
  const exec = {agent:{session:{header:{cwd:root}},options:{provider:'offline',model:'none'}},signal:new AbortController().signal};
  const preview = await service.preview(options,exec);
  assert.match(preview.files.find(file=>file.path===paths[0]).reason,/resource suffix/);
  settings = full;
  assert.deepEqual(eligibility(await service.preview(options,exec)),Object.fromEntries(paths.map(name=>[name,'reviewable'])));
});

test('SVN skips filtered bodies for fixed revisions and working copy without changing their inventory', async t => {
  const base = await fixture(t), repo=path.join(base,'repo'), root=path.join(base,'wc');
  await checked('svnadmin',['create',repo]);
  await checked('svn',['checkout','--non-interactive',pathToFileURL(repo).href,root]);
  const svn = (...args) => checked('svn',['--non-interactive',...args],{cwd:root});
  await put(root,'before\n'); await svn('add','--force','.'); await svn('commit','-m','base');
  await put(root,'after\n'); await svn('commit','-m','change');
  await put(root,'working\n');
  for (const [options, phase] of [[{svnRevision:'2'},'svn-history'],[{},'working-capture']]) {
    const filtered = await captureSnapshotWithMetrics(root,options);
    const unfiltered = await captureSnapshotWithMetrics(root,{...options,...full});
    assertFiltered(filtered,unfiltered,phase);
    assert.ok(filtered.metrics.phases[phase].commands < unfiltered.metrics.phases[phase].commands);
  }
});
