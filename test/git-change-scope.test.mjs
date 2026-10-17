import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checked } from '../src/process.mjs';
import { captureGit } from '../src/git.mjs';
import { captureSnapshot } from '../src/snapshot.mjs';
import { reviewSnapshot, markdownReport } from '../src/review.mjs';
import { createReviewService } from '../src/service.mjs';

async function fixture(t, prefix = 'dsh-change-scope-') {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => { assert.ok(path.basename(root).startsWith(prefix)); await rm(root, { recursive: true, force: true }); });
  const git = (...args) => checked('git', args, { cwd: root });
  await git('init', '-q');
  await git('config', 'user.name', 'Scope Test');
  await git('config', 'user.email', 'scope@example.invalid');
  await git('config', 'core.autocrlf', 'false');
  const put = (name, body) => writeFile(path.join(root, name), body);
  const commit = async () => { await git('add', '--all'); await git('commit', '-qm', 'fixture'); };
  return { root, git, put, commit };
}

const execFor = root => ({ agent: { session: { header: { cwd: root } }, options: { provider: 'offline', model: 'none' } }, signal: new AbortController().signal });

test('staged scope reviews index content while default keeps the worktree net change', async t => {
  const { root, git, put, commit } = await fixture(t);
  await put('a.js', 'old\n'); await commit();
  await put('a.js', 'staged\n'); await git('add', '--', 'a.js');
  await put('a.js', 'worktree\n');
  const net = await captureGit(root);
  assert.equal(net.changeScope, undefined);
  assert.equal(net.files[0].left.text, 'old\n');
  assert.equal(net.files[0].right.text, 'worktree\n');
  const staged = await captureGit(root, { changeScope: 'staged' });
  assert.equal(staged.changeScope, 'staged');
  assert.equal(staged.files[0].left.text, 'old\n');
  assert.equal(staged.files[0].right.text, 'staged\n');
  const unstaged = await captureGit(root, { changeScope: 'unstaged' });
  assert.equal(unstaged.changeScope, 'unstaged');
  assert.equal(unstaged.files[0].left.text, 'staged\n');
  assert.equal(unstaged.files[0].right.text, 'worktree\n');
  assert.equal(new Set([net.id, staged.id, unstaged.id]).size, 3);
});

test('staged scope keeps additions, deletions and renames independent of worktree edits', async t => {
  const { root, git, put, commit } = await fixture(t);
  await put('keep.js', 'keep\n'); await put('gone.js', 'gone\n'); await put('before.js', 'same\n'); await commit();
  await put('added.js', 'added\n'); await git('add', '--', 'added.js');
  await git('rm', '-q', '--', 'gone.js');
  await git('mv', 'before.js', 'after.js');
  await put('keep.js', 'keep worktree\n');
  await put('added.js', 'added worktree\n');
  const staged = await captureGit(root, { changeScope: 'staged' });
  assert.deepEqual(staged.files.map(f => f.path).sort(), ['added.js', 'after.js', 'gone.js']);
  assert.deepEqual(staged.files.find(f => f.path === 'added.js').right.text, 'added\n');
  assert.equal(staged.files.find(f => f.path === 'gone.js').rightExists, false);
  const renamed = staged.files.find(f => f.path === 'after.js');
  assert.equal(renamed.oldPath, 'before.js');
  assert.equal(renamed.left.text, 'same\n');
  assert.equal(renamed.right.text, 'same\n');
  assert.equal(renamed.eligibility, 'reviewable');
  const unstaged = await captureGit(root, { changeScope: 'unstaged' });
  assert.deepEqual(unstaged.files.map(f => f.path).sort(), ['added.js', 'keep.js']);
  assert.equal(unstaged.files.find(f => f.path === 'added.js').left.text, 'added\n');
});

test('unstaged scope excludes staged-only changes and uses the index as old side', async t => {
  const { root, git, put, commit } = await fixture(t);
  await put('a.js', 'v1\n'); await commit();
  await put('a.js', 'v2\n'); await git('add', '--', 'a.js');
  await put('staged-only.js', 'staged\n'); await git('add', '--', 'staged-only.js');
  assert.deepEqual((await captureGit(root, { changeScope: 'unstaged' })).files, []);
  await put('a.js', 'v3\n');
  const unstaged = await captureGit(root, { changeScope: 'unstaged' });
  assert.deepEqual(unstaged.files.map(f => f.path), ['a.js']);
  assert.equal(unstaged.files[0].left.text, 'v2\n');
  assert.equal(unstaged.files[0].right.text, 'v3\n');
});

test('untracked files stay opt-in and follow the selected scope', async t => {
  const { root, git, put, commit } = await fixture(t);
  await put('a.js', 'a\n'); await commit();
  await put('untracked.js', 'u\n');
  assert.equal((await captureGit(root)).files.find(f => f.path === 'untracked.js').eligibility, 'excluded');
  const skipped = await captureGit(root, { changeScope: 'unstaged' });
  assert.equal(skipped.files.find(f => f.path === 'untracked.js').eligibility, 'excluded');
  const selected = await captureGit(root, { changeScope: 'unstaged', selectedPaths: ['untracked.js'] });
  const file = selected.files.find(f => f.path === 'untracked.js');
  assert.equal(file.eligibility, 'reviewable');
  assert.equal(file.left.text, '');
  assert.equal(file.right.text, 'u\n');
  await assert.rejects(captureGit(root, { changeScope: 'staged', selectedPaths: ['untracked.js'] }), /not a current change/);
  await put('empty.js', '');
  const empty = await captureGit(root, { changeScope: 'unstaged', selectedPaths: ['empty.js'] });
  assert.equal(empty.files.find(f => f.path === 'empty.js').eligibility, 'reviewable');
});

test('snapshot identity follows only the observed sides', async t => {
  const { root, git, put, commit } = await fixture(t);
  await put('a.js', 'v1\n'); await commit();
  await put('a.js', 'v2\n'); await git('add', '--', 'a.js');
  const staged = await captureSnapshot(root, { changeScope: 'staged' });
  const unstaged1 = await captureSnapshot(root, { changeScope: 'unstaged' });
  await put('a.js', 'v3\n');
  assert.equal((await captureSnapshot(root, { changeScope: 'staged' })).id, staged.id);
  assert.notEqual((await captureSnapshot(root, { changeScope: 'unstaged' })).id, unstaged1.id);
  await put('a.js', 'v4\n'); await git('add', '--', 'a.js');
  assert.notEqual((await captureSnapshot(root, { changeScope: 'staged' })).id, staged.id);
  assert.equal((await captureSnapshot(root, { changeScope: 'worktree' })).id, (await captureSnapshot(root)).id);
});

test('invalid or incompatible scope parameters are rejected', async t => {
  const { root, put, commit } = await fixture(t);
  await put('a.js', 'a\n'); await commit();
  await put('a.js', 'b\n');
  await assert.rejects(captureSnapshot(root, { changeScope: 'index' }), /Invalid changeScope/);
  await assert.rejects(captureSnapshot(root, { changeScope: 'staged', commit: 'HEAD' }), /Git working-copy comparison only/);
  await assert.rejects(captureSnapshot(root, { changeScope: 'unstaged', svnRevision: '1' }), /Git working-copy comparison only/);
  const service = createReviewService({ async *stream() { throw new Error('Preview must not send'); } });
  try {
    await assert.rejects(service.preview({ changeScope: 'staged', reviewMode: 'project' }, execFor(root)), /Project mode supports only/);
    await assert.rejects(service.preview({ changeScope: 'index' }, execFor(root)), /Invalid changeScope/);
  } finally { service.dispose(); }
});

test('preview, model input and report disclose what the two sides are', async t => {
  const { root, git, put, commit } = await fixture(t);
  await put('a.js', 'old\n'); await commit();
  await put('a.js', 'staged-secret-content\n'); await git('add', '--', 'a.js');
  await put('a.js', 'worktree-secret-content\n');
  const service = createReviewService({ async *stream() { throw new Error('Preview must not send'); } });
  let preview;
  try {
    preview = await service.preview({ changeScope: 'staged' }, execFor(root));
  } finally { service.dispose(); }
  assert.equal(preview.changeScope, 'staged');
  assert.match(preview.notice, /暂存区/);
  assert.ok(!JSON.stringify(preview).includes('staged-secret-content'));
  assert.ok(!JSON.stringify(preview).includes('worktree-secret-content'));
  const snapshot = await captureSnapshot(root, { changeScope: 'staged' });
  const requests = [];
  const report = await reviewSnapshot(snapshot, async request => { requests.push(JSON.parse(request.input)); return { findings: [], limitations: [] }; });
  assert.equal(requests[0].changeScope, 'staged');
  assert.match(requests[0].changeScopeNotice, /暂存区/);
  assert.equal(requests[0].file.right.text, 'staged-secret-content\n');
  assert.equal(report.changeScope, 'staged');
  assert.match(markdownReport(report), /Git审查范围：Git 暂存区/);
});

test('unstaged scope drops staged-rename provenance from its compared entry', async t => {
  const { root, git, put, commit } = await fixture(t);
  await put('before.js', 'F0\n'); await commit();
  await git('mv', 'before.js', 'after.js');
  await put('after.js', 'G1\n');
  const unstaged = await captureGit(root, { changeScope: 'unstaged' });
  const file = unstaged.files.find(f => f.path === 'after.js');
  assert.equal(file.oldPath, undefined);
  assert.equal(file.rawStatus, ' M');
  assert.equal(file.left.text, 'F0\n');
  assert.equal(file.right.text, 'G1\n');
  const staged = await captureGit(root, { changeScope: 'staged' });
  assert.equal(staged.files.find(f => f.path === 'after.js').oldPath, 'before.js');
});

test('staged deletion and untracked recreation stay one entry per scope', async t => {
  const { root, git, put, commit } = await fixture(t);
  await put('x.js', 'base\n'); await commit();
  await git('rm', '-q', '--', 'x.js');
  await put('x.js', 'untracked-new\n');
  const staged = await captureGit(root, { changeScope: 'staged' });
  assert.equal(staged.files.length, 1);
  assert.equal(staged.files[0].path, 'x.js');
  assert.equal(staged.files[0].rawStatus, 'D ');
  assert.equal(staged.files[0].rightExists, false);
  const unstaged = await captureGit(root, { changeScope: 'unstaged' });
  assert.equal(unstaged.files.length, 1);
  assert.equal(unstaged.files[0].path, 'x.js');
  assert.equal(unstaged.files[0].rawStatus, '??');
  assert.equal(unstaged.files[0].eligibility, 'excluded');
  const selected = await captureGit(root, { changeScope: 'unstaged', selectedPaths: ['x.js'] });
  assert.equal(selected.files[0].eligibility, 'reviewable');
  assert.equal(selected.files[0].left.text, '');
  assert.equal(selected.files[0].right.text, 'untracked-new\n');
});

test('staged gitlink entry is blocked instead of reading submodule content', async t => {
  const { root, git, put, commit } = await fixture(t);
  await put('base', 'base'); await commit();
  const oid = (await git('rev-parse', 'HEAD')).toString().trim();
  await git('update-index', '--add', '--cacheinfo', '160000,' + oid + ',module');
  const staged = await captureGit(root, { changeScope: 'staged' });
  const item = staged.files.find(f => f.path === 'module');
  assert.equal(item.eligibility, 'blocked');
  assert.match(item.reason, /Submodule/);
});

test('unstaged or worktree change limit ignores unselected untracked files', async t => {
  const { root, git, put, commit } = await fixture(t);
  await put('a.js', 'a\n'); await commit();
  for (let i = 0; i < 5; i++) await put('untracked-' + i + '.js', 'u');
  await put('a.js', 'b\n');
  const unstaged = await captureGit(root, { changeScope: 'unstaged', maxFiles: 1 });
  assert.equal(unstaged.files.filter(f => f.eligibility === 'reviewable').length, 1);
  assert.ok(unstaged.files.filter(f => f.path !== 'a.js').every(f => f.eligibility === 'excluded'));
  const worktree = await captureGit(root, { maxFiles: 1 });
  assert.equal(worktree.files.filter(f => f.eligibility === 'reviewable').length, 1);
});
