import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checked } from '../src/process.mjs';
import { captureSvn, xml } from '../src/svn.mjs';
import { captureSnapshot } from '../src/snapshot.mjs';
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
  assert.deepEqual(xml(await svn('status', '--xml')), xml(before));
  const selected = await captureSvn(root, { selectedPaths: ['untracked'] });
  assert.equal(selected.files.find(f => f.path === 'untracked').right.text, 'secret');
});
test('SVN missing and copied files are blocked instead of treated as deletion/addition', async t => {
  const { root, svn, put } = await fixture(t);
  await put('file', 'base'); await svn('add', 'file'); await svn('commit', '-m', 'fixture');
  await svn('copy', 'file', 'copied'); await rm(path.join(root, 'file'));
  const result = await captureSvn(root);
  assert.equal(result.files.length, 2); assert.ok(result.files.every(f => f.eligibility === 'blocked'));
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
