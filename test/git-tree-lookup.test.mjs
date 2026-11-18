import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checked } from '../src/process.mjs';
import { lookupGitTreePaths } from '../src/git-tree-lookup.mjs';
import { captureSnapshot, captureSnapshotWithMetrics } from '../src/snapshot.mjs';

const lookupOptions = { maxBytes: 1024 * 1024, errorMessage: 'Invalid tree record' };
const oid = 'a'.repeat(40);
const record = name => Buffer.from('100644 blob ' + oid + '\t' + name + '\0');

async function fixture(t) {
  const prefix = 'dsh-tree-lookup-';
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    assert.ok(path.basename(root).startsWith(prefix));
    await rm(root, { recursive: true, force: true });
  });
  const git = (...args) => checked('git', args, { cwd: root });
  await git('init');
  await git('config', 'user.name', 'test');
  await git('config', 'user.email', 'test@example.com');
  return { root, git };
}

test('literal batches match single-path Git with directories, absent paths and Unicode', async t => {
  const { root, git } = await fixture(t);
  await mkdir(path.join(root, 'dir'));
  const files = ['dir/child.txt', 'dir/unrelated.txt', '-leading.txt', ' spaced 文本 [x].txt'];
  if (process.platform !== 'win32') files.push('dir/tabs\tand\nnewline.txt', 'dir/*.txt');
  for (const name of files) await writeFile(path.join(root, name), name);
  await git('add', '--all');
  await git('commit', '-qm', 'base');
  const requested = ['dir', '-leading.txt', 'dir/child.txt', ' spaced 文本 [x].txt', 'dir/missing.txt', ...files.slice(4)];
  const batches = [], actual = new Map(), expected = new Map();
  await lookupGitTreePaths('HEAD', actual, requested, args => {
    batches.push(args.slice(6));
    return git(...args);
  }, lookupOptions);
  for (const name of requested) {
    const row = (await git('--literal-pathspecs', 'ls-tree', '-z', '--full-tree', 'HEAD', '--', name)).toString();
    if (!row) continue;
    const [mode, type, id] = row.slice(0, row.indexOf('\t')).split(' ');
    expected.set(name, { mode, type, oid: id });
  }
  assert.deepEqual(actual, expected);
  assert.equal(batches.length, 2);
  assert.ok(!batches.some(batch => batch.includes('dir') && batch.some(p => p.startsWith('dir/'))));
  assert.ok(!actual.has('dir/unrelated.txt'));
});

test('tree lookup bounds batch bytes, rejects unexpected rows and observes cancellation before next batch', async () => {
  const seen = [];
  const names = Array.from({ length: 3 }, (_, i) => 'p' + i);
  await lookupGitTreePaths('HEAD', new Map(), names, async args => {
    seen.push(args.slice(6));
    return Buffer.concat(args.slice(6).map(record));
  }, { ...lookupOptions, maxBytes: 165 });
  assert.deepEqual(seen, [names.slice(0, 2), names.slice(2)]);
  await assert.rejects(lookupGitTreePaths('HEAD', new Map(), ['p0'], async () => record('dir/unapproved'), lookupOptions), /Invalid tree record/);
  await assert.rejects(lookupGitTreePaths('HEAD', new Map(), ['p0'], async () => Buffer.concat([record('p0'), record('p0')]), lookupOptions), /Invalid tree record/);
  const stop = new AbortController();
  let calls = 0;
  await assert.rejects(lookupGitTreePaths('HEAD', new Map(), names, async () => {
    calls++;
    stop.abort(new Error('stop lookup'));
    return Buffer.alloc(0);
  }, { ...lookupOptions, maxBytes: 100, signal: stop.signal }), /stop lookup/);
  assert.equal(calls, 1);
});

test('snapshots keep exact sides and do not embed opt-in per-stage metrics', async t => {
  const { root, git } = await fixture(t);
  const names = Array.from({ length: 70 }, (_, i) => 'file-' + String(i).padStart(2, '0') + '.txt');
  for (const name of names) await writeFile(path.join(root, name), 'old ' + name);
  await git('add', '--all');
  await git('commit', '-qm', 'base');
  await writeFile(path.join(root, names[0]), 'history endpoint');
  await git('add', '--', names[0]);
  await git('commit', '-qm', 'target');
  for (const name of names) await writeFile(path.join(root, name), 'local ' + name);
  const [small, bulk, history] = await Promise.all([
    captureSnapshotWithMetrics(root, { selectedPaths: names.slice(0, 1) }),
    captureSnapshotWithMetrics(root, { selectedPaths: names }),
    captureSnapshotWithMetrics(root, { commit: 'HEAD', contextPaths: names.slice(1, 6) }),
  ]);
  for (const [value, count] of [[small, 1], [bulk, 2]]) {
    const phases = value.metrics.phases;
    assert.equal(phases['working-capture'].treeQueries, count);
    assert.equal(phases['working-recheck'].treeQueries, count);
    assert.ok(phases['working-capture'].localSourceBytes > 0);
    assert.equal(phases['working-capture'].sourceStdoutBytes, phases['working-recheck'].sourceStdoutBytes);
    assert.equal(phases['working-capture'].localSourceBytes, phases['working-recheck'].localSourceBytes);
    assert.doesNotMatch(JSON.stringify(value.metrics), /old |local |file-00/);
  }
  assert.deepEqual(bulk.snapshot, await captureSnapshot(root, { selectedPaths: names }));
  assert.equal(bulk.snapshot.files[0].left.text, 'history endpoint');
  assert.equal(bulk.snapshot.files[0].right.text, 'local ' + names[0]);
  assert.equal(history.metrics.phases['git-history'].treeQueries, 2);
  assert.ok(history.snapshot.context.every(item => item.text === 'old ' + item.path && item.oldText === item.text));
});
