import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checked } from '../src/process.mjs';
import { captureGit } from '../src/git.mjs';
import { captureGitHistory } from '../src/git-history.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-git-current-'));
  t.after(async () => { assert.ok(path.basename(root).startsWith('dsh-git-current-')); await rm(root, { recursive: true, force: true }); });
  const git = (...args) => checked('git', args, { cwd: root });
  await git('init', '-q');
  await git('config', 'user.name', 'Test');
  await git('config', 'user.email', 'test@example.invalid');
  await git('config', 'core.autocrlf', 'false');
  const put = async (name, body) => { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), body); };
  const commit = async () => { await git('add', '--all'); await git('commit', '-qm', 'fixture'); };
  return { root, git, put, commit };
}

for (const source of ['a.js', '[a].js']) {
  test('rename back after staged rename compares original HEAD path: ' + source, async t => {
    const { root, git, put, commit } = await fixture(t);
    await put(source, 'before\n'); await commit();
    await git('mv', '--', source, 'b.js');
    await rename(path.join(root, 'b.js'), path.join(root, source));
    await put('untracked.js', 'unauthorized\n');
    const status = await git('status', '--porcelain=v1', '-z');
    assert.ok(status.includes(Buffer.from('RD b.js\0' + source + '\0')));
    assert.ok(status.includes(Buffer.from('?? ' + source + '\0')));
    const index = await readFile(path.join(root, '.git', 'index'));
    for (const selectedPaths of [undefined, [source]]) {
      const result = await captureGit(root, { selectedPaths, maxFiles: 1 });
      assert.equal(result.files.some(f => f.path === 'b.js'), false);
      const file = result.files.find(f => f.path === source);
      assert.equal(file.eligibility, 'excluded');
      assert.match(file.reason, /No net content change/);
      assert.equal(file.left.text, 'before\n'); assert.equal(file.right.text, 'before\n');
      assert.equal(result.files.find(f => f.path === 'untracked.js').eligibility, 'excluded');
    }
    await put(source, 'after\n');
    const net = await captureGit(root);
    assert.equal(new Set(net.files.map(f => f.id)).size, net.files.length);
    const file = net.files.find(f => f.path === source);
    assert.equal(file.eligibility, 'reviewable');
    assert.equal(file.oldPath, undefined);
    assert.equal(file.left.text, 'before\n'); assert.equal(file.right.text, 'after\n');
    const staged = await captureGit(root, { changeScope: 'staged' });
    assert.equal(staged.files.length, 1);
    assert.equal(staged.files[0].path, 'b.js'); assert.equal(staged.files[0].oldPath, source);
    assert.equal(staged.files[0].left.text, 'before\n'); assert.equal(staged.files[0].right.text, 'before\n');
    const unstaged = await captureGit(root, { changeScope: 'unstaged' });
    const deleted = unstaged.files.find(f => f.path === 'b.js');
    assert.equal(deleted.oldPath, undefined); assert.equal(deleted.rightExists, false);
    assert.equal(deleted.left.text, 'before\n');
    assert.equal(unstaged.files.find(f => f.path === source).eligibility, 'excluded');
    const explicit = await captureGit(root, { changeScope: 'unstaged', selectedPaths: [source] });
    assert.equal(explicit.files.find(f => f.path === source).left.text, '');
    assert.equal(explicit.files.find(f => f.path === source).right.text, 'after\n');
    await assert.rejects(captureGit(root, { selectedPaths: ['../a.js'] }), /Unsafe/);
    assert.deepEqual(await git('status', '--porcelain=v1', '-z'), status);
    assert.deepEqual(await readFile(path.join(root, '.git', 'index')), index);
    await rm(path.join(root, source));
    const removed = (await captureGit(root)).files.find(f => f.path === source);
    assert.equal(removed.eligibility, 'reviewable'); assert.equal(removed.rightExists, false);
  });
}

test('rename source authority does not bypass credential or local link exclusions', async t => {
  const { root, git, put, commit } = await fixture(t);
  await put('.env', 'credential\n'); await put('a.js', 'before\n'); await commit();
  await git('mv', '--', '.env', 'hidden.js'); await rename(path.join(root, 'hidden.js'), path.join(root, '.env'));
  const secret = (await captureGit(root)).files.find(f => f.path === '.env');
  assert.equal(secret.eligibility, 'excluded'); assert.equal(secret.left, undefined);
  await git('mv', '--', 'a.js', 'b.js'); await rm(path.join(root, 'b.js'));
  // A directory junction is available without Windows symlink privileges.
  await mkdir(path.join(root, 'target')); await put('target/private.js', 'not authorized\n');
  await symlink(path.join(root, 'target'), path.join(root, 'a.js'), process.platform === 'win32' ? 'junction' : 'dir');
  const linked = (await captureGit(root)).files.find(f => f.path === 'a.js');
  assert.equal(linked.eligibility, 'blocked'); assert.equal(linked.right, undefined);
});

test('raw ISO8859-1 commit messages and identities do not affect ASCII parent parsing', async t => {
  const { root, git, put, commit } = await fixture(t);
  await put('a.js', 'before\n'); await commit();
  const parent = (await git('rev-parse', 'HEAD')).toString().trim();
  await put('a.js', 'after\n'); await git('add', '--', 'a.js');
  const tree = (await git('write-tree')).toString().trim();
  const identity = 'author Andr\xe9 <test@example.invalid> 1700000000 +0000\ncommitter Test <test@example.invalid> 1700000000 +0000\n';
  const rawCommit = async header => {
    const body = Buffer.from(header, 'latin1');
    await writeFile(path.join(root, '.git', 'raw-commit'), body);
    const oid = (await git('hash-object', '-t', 'commit', '-w', '--literally', '--', '.git/raw-commit')).toString().trim();
    assert.deepEqual(await git('cat-file', 'commit', oid), body);
    return oid;
  };
  for (const parents of ['', 'parent ' + parent + '\n']) {
    const oid = await rawCommit('tree ' + tree + '\n' + parents + identity + 'encoding ISO-8859-1\ngpgsig signature\n continuation\n\nCaf\xe9\nparent ' + 'f'.repeat(40) + '\n');
    const result = await captureGitHistory(root, { commit: oid });
    assert.equal(result.baseline, parents ? parent : null);
    assert.equal(result.files[0].left.text, parents ? 'before\n' : '');
    assert.equal(result.files[0].right.text, 'after\n');
  }
  for (const malformed of ['parent ' + parent.slice(0, -1) + '\xff\n', 'parent ' + parent + ' extra\n', 'parent\n']) {
    const oid = await rawCommit('tree ' + tree + '\n' + malformed + identity + '\nmessage\n');
    await assert.rejects(captureGitHistory(root, { commit: oid }), /Invalid commit|git failed/);
  }
  const noSeparator = await rawCommit('tree ' + tree + '\n' + identity);
  await assert.rejects(captureGitHistory(root, { commit: noSeparator }), /Invalid commit|git failed/);
  const merge = await rawCommit('tree ' + tree + '\nparent ' + parent + '\nparent ' + parent + '\n' + identity + '\nmessage\n');
  await assert.rejects(captureGitHistory(root, { commit: merge }), /Merge commit requires explicit revision range/);
});
