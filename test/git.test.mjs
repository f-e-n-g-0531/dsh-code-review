import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checked } from '../src/process.mjs';
import { captureGit } from '../src/git.mjs';
import { decode, readLocal, relativePath } from '../src/content.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-review-git-'));
  t.after(async () => { assert.ok(path.basename(root).startsWith('dsh-review-git-')); await rm(root, { recursive: true, force: true }); });
  const git = (...args) => checked('git', args, { cwd: root });
  await git('init', '-q');
  await git('config', 'user.name', 'Review Test');
  await git('config', 'user.email', 'review@example.invalid');
  await git('config', 'core.autocrlf', 'false');
  const put = (name, body) => writeFile(path.join(root, name), body);
  const commit = async () => { await git('add', '--all'); await git('commit', '-qm', 'fixture'); };
  return { root, git, put, commit };
}

test('Git captures modified, deleted and explicitly selected untracked files without writes', async t => {
  const { root, git, put, commit } = await fixture(t);
  await put('中文 @ [].js', 'old\n'); await put('deleted.js', 'removed\n'); await commit();
  await put('中文 @ [].js', 'new\n'); await rm(path.join(root, 'deleted.js')); await put('-new.js', 'added\n');
  const before = await git('status', '--porcelain=v1', '-z');
  const index = await readFile(path.join(root, '.git', 'index'));
  const snapshot = await captureGit(root);
  assert.equal(snapshot.files.length, 3);
  const modified = snapshot.files.find(f => f.path === '中文 @ [].js');
  assert.equal(modified.left.text, 'old\n'); assert.equal(modified.right.text, 'new\n');
  assert.equal(snapshot.files.find(f => f.path === 'deleted.js').right.text, '');
  assert.equal(snapshot.files.find(f => f.path === '-new.js').eligibility, 'excluded');
  const selected = await captureGit(root, { selectedPaths: ['-new.js'] });
  assert.equal(selected.files.find(f => f.path === '-new.js').right.text, 'added\n');
  assert.deepEqual(await git('status', '--porcelain=v1', '-z'), before);
  assert.deepEqual(await readFile(path.join(root, '.git', 'index')), index);
  assert.equal((await captureGit(root)).id, snapshot.id);
  await put('中文 @ [].js', 'new again\n');
  assert.notEqual((await captureGit(root)).id, snapshot.id);
});

test('unborn repository uses empty baseline', async t => {
  const { root, git, put } = await fixture(t);
  await put('new.js', 'new'); await git('add', '--', 'new.js');
  const result = await captureGit(root);
  assert.equal(result.baseline, null); assert.equal(result.files[0].left.text, ''); assert.equal(result.files[0].right.text, 'new');
});

test('staged rename keeps both paths and baseline', async t => {
  const { root, git, put, commit } = await fixture(t);
  await put('before.js', 'same\n'); await commit(); await git('mv', 'before.js', 'after.js');
  const result = await captureGit(root);
  assert.equal(result.files[0].oldPath, 'before.js'); assert.equal(result.files[0].path, 'after.js');
  assert.equal(result.files[0].eligibility, 'reviewable');
});

test('binary and large files are blocked; invalid selection fails', async t => {
  const { root, put, commit } = await fixture(t);
  await put('binary', 'old'); await put('large', 'old'); await commit();
  await put('binary', Buffer.from([0, 1, 2])); await put('large', 'x'.repeat(100));
  const result = await captureGit(root, { maxFileBytes: 50 });
  assert.ok(result.files.every(f => f.eligibility === 'blocked'));
  await assert.rejects(captureGit(root, { selectedPaths: ['missing'] }), /not a current change/);
});

test('empty additions and deletions remain reviewable', async t => {
  const { root, git, put, commit } = await fixture(t);
  await put('empty-old', ''); await commit();
  await rm(path.join(root, 'empty-old')); await put('empty-new', ''); await git('add', '--', 'empty-new');
  const result = await captureGit(root);
  assert.equal(result.files.length, 2);
  assert.ok(result.files.every(f => f.eligibility === 'reviewable'));
});

test('path traversal and metadata paths are rejected', () => {
  for (const name of ['../x', '/root', 'C:/x', '.git/config', 'a/.svn/x', 'a//b', 'a/./b']) assert.throws(() => relativePath(name));
});

test('UTF16 supports BOM; invalid UTF8 is not silently replaced', () => {
  assert.equal(decode(Buffer.concat([Buffer.from([255, 254]), Buffer.from('你好', 'utf16le')])).text, '你好');
  assert.throws(() => decode(Buffer.from([0xff])));
});

test('junction escape is rejected', async t => {
  const { root } = await fixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'dsh-review-outside-'));
  t.after(async () => { assert.ok(path.basename(outside).startsWith('dsh-review-outside-')); await rm(outside, { recursive: true, force: true }); });
  await writeFile(path.join(outside, 'secret'), 'private');
  await symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readLocal(root, 'escape/secret'), /links|junction/);
});
