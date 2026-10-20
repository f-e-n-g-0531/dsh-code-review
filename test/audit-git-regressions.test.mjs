import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checked } from '../src/process.mjs';
import { captureSnapshot } from '../src/snapshot.mjs';
import { gitContextIndex } from '../src/tracked-context.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-audit-git-'));
  t.after(async () => { assert.ok(path.basename(root).startsWith('dsh-audit-git-')); await rm(root, { recursive: true, force: true }); });
  const git = (...args) => checked('git', args, { cwd: root });
  await git('init', '-q');
  await git('config', 'user.name', 'Audit Test');
  await git('config', 'user.email', 'audit@example.invalid');
  await git('config', 'core.autocrlf', 'false');
  const put = async (name, body) => { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), body); };
  const commit = async () => { await git('add', '--all'); await git('commit', '-qm', 'fixture'); };
  return { root, git, put, commit };
}

test('staged deletion plus untracked recreation has one net worktree identity without expanding untracked authority', async t => {
  const { root, git, put, commit } = await fixture(t);
  await put('a.js', 'old\n'); await commit();
  await git('rm', '-q', '--', 'a.js'); await put('a.js', 'recreated\n');
  await put('untracked.js', 'not selected\n');
  const status = await git('status', '--porcelain=v1', '-z');
  assert.match(status.toString(), /D  a.js\0/); assert.match(status.toString(), /\?\? a.js\0/);
  const index = await readFile(path.join(root, '.git', 'index'));
  for (const selectedPaths of [undefined, ['a.js']]) {
    const snapshot = await captureSnapshot(root, { selectedPaths, maxFiles: 1 });
    assert.equal(snapshot.files.filter(f => f.path === 'a.js').length, 1);
    assert.equal(new Set(snapshot.files.map(f => f.id)).size, snapshot.files.length);
    const file = snapshot.files.find(f => f.path === 'a.js');
    assert.equal(file.eligibility, 'reviewable'); assert.equal(file.left.text, 'old\n'); assert.equal(file.right.text, 'recreated\n');
    assert.equal(snapshot.files.find(f => f.path === 'untracked.js').eligibility, 'excluded');
    assert.equal(createRetrievalScope(snapshot).catalog().length, 2);
  }
  const staged = await captureSnapshot(root, { changeScope: 'staged' });
  assert.equal(staged.files.length, 1); assert.equal(staged.files[0].rightExists, false);
  const unstaged = await captureSnapshot(root, { changeScope: 'unstaged', selectedPaths: ['a.js'] });
  assert.equal(unstaged.files.find(f => f.path === 'a.js').left.text, '');
  assert.equal(unstaged.files.find(f => f.path === 'a.js').right.text, 'recreated\n');
  const implicit = await captureSnapshot(root, { changeScope: 'unstaged' });
  assert.equal(implicit.files.find(f => f.path === 'a.js').eligibility, 'excluded');
  assert.deepEqual(await git('status', '--porcelain=v1', '-z'), status);
  assert.deepEqual(await readFile(path.join(root, '.git', 'index')), index);
  await put('a.js', 'old\n');
  assert.equal((await captureSnapshot(root)).files.find(f => f.path === 'a.js').eligibility, 'excluded');
});

test('directory import resolves only independently probed tracked index file', async t => {
  const { root, put, commit } = await fixture(t);
  await put('main.js', 'export const before = 1;\n');
  await put('dep/index.js', 'export const dep = 1;\n');
  await put('dep/private/hidden.js', 'do not capture\n'); await commit();
  await put('main.js', "import { dep } from './dep';\nexport const after = dep;\n");
  const snapshot = await captureSnapshot(root, { autoContext: true });
  assert.deepEqual(snapshot.context.map(c => c.path), ['dep/index.js']);
  assert.deepEqual(snapshot.autoContext.capturedPaths, ['dep/index.js']);
  assert.doesNotThrow(() => createRetrievalScope(snapshot));
});

test('exact directory probes exclude even large descendants and preserve literal metacharacters', async t => {
  const { root, git, put } = await fixture(t);
  await put('dep/' + 'long'.repeat(40) + '/hidden.js', 'hidden');
  await put('dep/index.js', 'index'); await put('[dep]/index.js', 'brackets'); await put('[file].js', 'literal');
  await put('file.js', 'not literal'); await git('add', '--all');
  const oid = (await git('hash-object', '--', 'dep/index.js')).toString().trim();
  // Index-only records avoid filesystem filename restrictions. Git for Windows
  // additionally needs its platform path check disabled for this fixture only.
  await git('config', 'core.protectNTFS', 'false');
  for (const name of ['star*dir/hidden.js', 'question?dir/hidden.js', 'star*.js', 'question?.js']) {
    await git('update-index', '--add', '--cacheinfo', '100644', oid, name);
  }
  const dirs = ['dep', '[dep]', 'star*dir', 'question?dir'];
  const before = await gitContextIndex(root, { probePaths: dirs });
  assert.deepEqual(before.paths, []); assert.equal(before.fingerprint, '');
  const exact = ['dep/index.js', '[dep]/index.js', '[file].js', 'star*.js', 'question?.js'];
  assert.deepEqual((await gitContextIndex(root, { probePaths: exact })).paths, exact.sort());
  assert.deepEqual((await gitContextIndex(root, { probePaths: ['dep/*', 'dep/?', 'missing'] })).paths, []);
  await assert.rejects(gitContextIndex(root, { probePaths: ['../dep'] }), /Unsafe/);
  await assert.rejects(gitContextIndex(root, { probePaths: ['dep', 'dep'] }), /probes/);
});

for (const autoContext of [false, true]) {
  test('staged overlapping context stays index-side despite differing or missing local file; autoContext=' + autoContext, async t => {
    const { root, git, put, commit } = await fixture(t);
    await put('a.js', 'old\n'); await put('context.js', 'context old\n'); await commit();
    await put('a.js', 'staged\n'); await git('add', '--', 'a.js');
    await put('a.js', 'unstaged secret-looking body\n'); await put('context.js', 'context working\n');
    const options = { changeScope: 'staged', contextPaths: ['a.js', 'context.js'], autoContext };
    const snapshot = await captureSnapshot(root, options);
    assert.equal(snapshot.files[0].right.text, 'staged\n');
    assert.equal(snapshot.context.find(c => c.path === 'a.js').text, 'staged\n');
    assert.equal(snapshot.context.find(c => c.path === 'context.js').text, 'context working\n');
    assert.doesNotThrow(() => createRetrievalScope(snapshot));
    await rm(path.join(root, 'a.js'));
    assert.equal((await captureSnapshot(root, options)).id, snapshot.id);
    await put('a.js', 'new index\n'); await git('add', '--', 'a.js');
    assert.notEqual((await captureSnapshot(root, options)).id, snapshot.id);
    await git('rm', '-q', '-f', '--', 'a.js');
    await assert.rejects(captureSnapshot(root, options), /deleted|Deleted/);
  });
}

test('duplicate-path normalization retains credential and explicit selection boundaries', async t => {
  const { root, git, put, commit } = await fixture(t);
  await put('.env', 'old credential'); await put('a.js', 'old'); await commit();
  await git('rm', '-q', '--', '.env', 'a.js');
  await put('.env', 'new credential'); await put('a.js', 'new');
  const snapshot = await captureSnapshot(root, { selectedPaths: ['.env'] });
  assert.equal(snapshot.files.length, 2);
  assert.ok(snapshot.files.every(f => f.eligibility === 'excluded'));
  assert.ok(snapshot.files.every(f => !f.right));
  assert.deepEqual(createRetrievalScope(snapshot).catalog(), []);
});
