import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { checked } from '../src/process.mjs';
import { projectInventory, captureProjectBatch } from '../src/project-snapshot.mjs';
import { createReviewService } from '../src/service.mjs';

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-project-selection-'));
  t.after(async () => {
    assert.ok(path.basename(root).startsWith('dsh-project-selection-'));
    // Git output-limit cancellation can leave Windows releasing the cwd briefly.
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const git = (...args) => checked('git', args, { cwd: root });
  await git('init', '-q');
  await git('config', 'user.name', 'test');
  await git('config', 'user.email', 'test@example.invalid');
  await git('config', 'core.autocrlf', 'false');
  const inputGit = (args, input = '') => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
    const result = spawnSync('git', args, { cwd: root, input, encoding: 'utf8', env,
      timeout: 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const source = async (name, body = 'export const value = 1;\n') => {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), body);
  };
  return { root, git, inputGit, source };
}

function reviewer(t, root, { onSend = () => {}, authorize = async () => true } = {}) {
  let sends = 0;
  const service = createReviewService({ async *stream(request) {
    sends++;
    await onSend(request);
    yield { type: 'text-delta', text: JSON.stringify({ findings: [], limitations: [] }) };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } }, { allowModelSending: true, authorize });
  t.after(() => service.dispose());
  const exec = { agent: { session: { header: { cwd: root } }, options: { provider: 'test', model: 'test' } } };
  return { service, exec, sends: () => sends,
    preview: selectedPaths => service.preview({ reviewMode: 'project', ...(selectedPaths === undefined ? {} : { selectedPaths }) }, exec),
    execute: preview => service.execute({ previewId: preview.previewId, confirmed: true }, exec) };
}

function selectedMetadata(value, count) {
  assert.equal(value.inventoryScope, 'selected');
  assert.equal(value.inventoryComplete, false);
  assert.equal(value.totalTrackedNodes, null);
  assert.equal(value.inventoryNodes, count);
  if ('selectionComplete' in value) assert.equal(value.selectionComplete, false);
}

function repositoryMetadata(value, count) {
  assert.equal(value.inventoryScope, 'repository');
  assert.equal(value.inventoryComplete, true);
  assert.equal(value.totalTrackedNodes, count);
  assert.equal(value.inventoryNodes, count);
  if ('selectionComplete' in value) assert.equal(value.selectionComplete, true);
}

test('explicit five-file and empty selections bypass a real oversized Git index without expanding source scope', async t => {
  const { root, git, inputGit, source } = await repository(t);
  const selected = Array.from({ length: 5 }, (_, i) => 'selected/source-' + i + '.js');
  for (const [i, name] of selected.entries()) await source(name, 'export const value = ' + i + ';\n');
  await git('add', '--', ...selected);
  const emptyOid = inputGit(['hash-object', '-w', '--stdin']);
  // These are real index entries but deliberately have no working-tree files.
  // A repository-wide inventory or body capture cannot silently pass this fixture.
  const syntheticCount = 11001;
  const indexInfo = Array.from({ length: syntheticCount }, (_, i) =>
    '100644 ' + emptyOid + '	synthetic/' + String(i).padStart(5, '0') + '/' + 'x'.repeat(170) + '.js\n').join('');
  inputGit(['update-index', '--index-info'], indexInfo);
  const index = await checked('git', ['ls-files', '--stage', '-z'], { cwd: root, maxBytes: 8 * 1024 * 1024 });
  assert.ok(index.length > 2 * 1024 * 1024, 'fixture must exceed the old 2MiB inventory cap');
  assert.equal(index.toString('utf8').split('\0').filter(Boolean).length, syntheticCount + selected.length);
  assert.ok(syntheticCount + selected.length > 10000);

  let approved;
  const sentPaths = [];
  const review = reviewer(t, root, {
    authorize: async ({ snapshot }) => { approved = snapshot; return true; },
    onSend: request => {
      const input = JSON.parse(request.messages[0].content[0].text);
      sentPaths.push(input.file.path);
      assert.ok(selected.includes(input.file.path));
      assert.match(input.file.right.text, /^export const value = [0-4];\n$/);
      assert.ok(!JSON.stringify(input).includes('synthetic/'));
    },
  });
  const preview = await review.preview([...selected].reverse());
  selectedMetadata(preview, 5);
  assert.equal(preview.selectionComplete, false);
  assert.equal(preview.selectedFiles, 5);
  assert.deepEqual(preview.files.map(file => file.path), selected);
  assert.ok(preview.files.every(file => file.eligibility === 'reviewable'));
  assert.equal(review.sends(), 0);
  assert.match(preview.notice, /repository total is unknown/);
  const { report } = await review.execute(preview);
  selectedMetadata(approved, 5);
  selectedMetadata(approved.batches[0].projectScope, 5);
  assert.deepEqual(approved.batches.flatMap(batch => batch.files.map(file => file.path)), selected);
  selectedMetadata(report, 5);
  assert.equal(report.selectionComplete, false);
  selectedMetadata(report.batches[0].projectScope, 5);
  assert.deepEqual(report.coverage, { total: 5, completed: 5, excluded: 0, blocked: 0, pending: 0 });
  assert.equal(report.outdated, false);
  assert.deepEqual(sentPaths.sort(), selected);
  assert.equal(review.sends(), 5);

  const empty = await review.preview([]);
  selectedMetadata(empty, 0);
  assert.equal(empty.selectionComplete, false);
  assert.equal(empty.selectedFiles, 0);
  assert.equal(empty.batches, 0);
  assert.deepEqual(empty.files, []);
  const noReview = await review.execute(empty);
  selectedMetadata(noReview.report, 0);
  assert.equal(noReview.report.selectionComplete, false);
  assert.equal(noReview.report.status, 'partial');
  assert.equal(noReview.report.coverage.total, 0);
  assert.equal(noReview.report.outdated, false);
  assert.equal(review.sends(), 5);
  // A directory containing the oversized synthetic subtree must be rejected as
  // an exact-file miss, rather than first expanding and hitting an output cap.
  await assert.rejects(review.preview(['synthetic']), /selection/);
  await assert.rejects(review.preview(), /output limit|10000|1000/);
});

test('full Git scope retains complete repository inventory while explicit all-files scope remains selected', async t => {
  const { root, git, source } = await repository(t);
  for (const name of ['a.js', 'b.js']) await source(name);
  await git('add', '.');
  let approved;
  const review = reviewer(t, root, { authorize: async ({ snapshot }) => { approved = snapshot; return true; } });
  const full = await review.preview();
  repositoryMetadata(full, 2);
  assert.equal(full.selectionComplete, true);
  const result = await review.execute(full);
  repositoryMetadata(approved.batches[0].projectScope, 2);
  repositoryMetadata(result.report, 2);
  repositoryMetadata(result.report.batches[0].projectScope, 2);
  assert.equal(result.report.selectionComplete, true);
  const explicit = await review.preview(['b.js', 'a.js']);
  selectedMetadata(explicit, 2);
  assert.equal(explicit.selectionComplete, false);
});

test('selected Git paths are literal exact files, not options, wildcard patterns, directories or prefixes', async t => {
  const { root, git, source } = await repository(t);
  const names = ['--stage', '[ab].js', 'a.js', 'b.js', 'dir/child.js', 'directory.js',
    'folder[1]/child.js', 'folder1/sibling.js', 'space name.js'];
  if (process.platform !== 'win32') names.push('star*.js', 'question?.js');
  for (const name of names) await source(name);
  await git('add', '--', ...names);
  const review = reviewer(t, root);
  for (const name of names) {
    const preview = await review.preview([name]);
    selectedMetadata(preview, 1);
    assert.deepEqual(preview.files.map(file => file.path), [name]);
    assert.equal(preview.files[0].eligibility, 'reviewable');
  }
  for (const name of ['dir', 'dir/', 'dire', '*.js', 'a?.js', ':(glob)**', ':', '--']) {
    await assert.rejects(review.preview([name]), /selection|repository path|literal path/);
  }
  await assert.rejects(review.preview(['folder[1]']), /selection/);
  assert.equal(review.sends(), 0);
});

test('malformed selections fail validation before inventory and untracked paths are never accepted', async t => {
  const { root, git, source } = await repository(t);
  await source('tracked.js');
  await source('untracked.js', 'DO NOT SEND UNTRACKED SOURCE');
  await source('ignored.js', 'DO NOT SEND IGNORED SOURCE');
  await source('.gitignore', 'ignored.js\n');
  await git('add', '--', 'tracked.js', '.gitignore');
  const invalid = [null, 'tracked.js', {}, [null], [undefined], [123], [''], ['../tracked.js'],
    ['/tracked.js'], ['./tracked.js'], ['dir//file.js'], ['dir/../tracked.js'], ['dir\\file.js'],
    ['C:/tracked.js'], ['.git/config'], ['.svn/entries'], ['tracked.js', 'tracked.js'],
    Array.from({ length: 1001 }, (_, i) => i + '.js')];
  for (const selectedPaths of invalid) {
    await assert.rejects(projectInventory(path.join(root, 'missing-root'), 'git', { selectedPaths }),
      /selection|Unsafe repository path/, 'must validate before attempting repository access: ' + JSON.stringify(selectedPaths));
  }
  const review = reviewer(t, root);
  for (const selectedPaths of invalid) await assert.rejects(review.preview(selectedPaths), /selection|Unsafe repository path/);
  for (const name of ['untracked.js', 'ignored.js', 'missing.js']) {
    await assert.rejects(review.preview([name]), /selection/);
  }
  assert.equal(review.sends(), 0);
});

test('selected source or index identity changes invalidate approval before any authorization or model send', async t => {
  for (const change of ['source', 'index-oid', 'index-mode', 'index-removal']) {
    await t.test(change, async t => {
      const { root, git, inputGit, source } = await repository(t);
      await source('selected.js');
      await git('add', '--', 'selected.js');
      let authorizations = 0;
      const review = reviewer(t, root, { authorize: async () => { authorizations++; return true; } });
      const preview = await review.preview(['selected.js']);
      if (change === 'source') await source('selected.js', 'export const value = 999;\n');
      if (change === 'index-oid') {
        const oid = inputGit(['hash-object', '-w', '--stdin'], 'different index content\n');
        inputGit(['update-index', '--index-info'], '100644 ' + oid + '	selected.js\n');
      }
      if (change === 'index-mode') {
        const oid = (await git('rev-parse', ':selected.js')).toString('utf8').trim();
        inputGit(['update-index', '--index-info'], '100755 ' + oid + '	selected.js\n');
      }
      if (change === 'index-removal') await git('update-index', '--force-remove', '--', 'selected.js');
      await assert.rejects(review.execute(preview), /changed|selection/);
      assert.equal(authorizations, 0);
      assert.equal(review.sends(), 0);
    });
  }
});

test('unrelated index and source changes do not invalidate selected approval or mark its report outdated', async t => {
  const { root, git, inputGit, source } = await repository(t);
  await source('selected.js');
  await source('unrelated.js');
  await git('add', '.');
  let duringReview = false;
  const review = reviewer(t, root, { onSend: async () => {
    assert.equal(duringReview, false);
    duringReview = true;
    const oid = inputGit(['hash-object', '-w', '--stdin'], 'unrelated during review\n');
    inputGit(['update-index', '--index-info'], '100644 ' + oid + '	unrelated.js\n');
  } });
  const preview = await review.preview(['selected.js']);
  await source('unrelated.js', 'unrelated before execute\n');
  await git('add', '--', 'unrelated.js');
  const afterMutation = await review.preview(['selected.js']);
  assert.equal(afterMutation.snapshotId, preview.snapshotId);
  const result = await review.execute(preview);
  assert.equal(review.sends(), 1);
  assert.equal(result.report.outdated, false);
  assert.deepEqual(result.report.files.map(file => file.path), ['selected.js']);
  selectedMetadata(result.report, 1);
});

test('selected source and index mutations during review mark the approved report outdated', async t => {
  for (const change of ['source', 'index-oid', 'index-mode']) {
    await t.test(change, async t => {
      const { root, git, inputGit, source } = await repository(t);
      await source('selected.js');
      await git('add', '--', 'selected.js');
      const originalOid = (await git('rev-parse', ':selected.js')).toString('utf8').trim();
      const review = reviewer(t, root, { onSend: async () => {
        if (change === 'source') await source('selected.js', 'export const value = 999;\n');
        if (change === 'index-oid') {
          const oid = inputGit(['hash-object', '-w', '--stdin'], 'new staged source\n');
          inputGit(['update-index', '--index-info'], '100644 ' + oid + '	selected.js\n');
        }
        if (change === 'index-mode') {
          inputGit(['update-index', '--index-info'], '100755 ' + originalOid + '	selected.js\n');
        }
      } });
      const preview = await review.preview(['selected.js']);
      const { report } = await review.execute(preview);
      selectedMetadata(report, 1);
      assert.equal(report.snapshotId, preview.snapshotId);
      assert.equal(report.coverage.completed, 1);
      assert.equal(report.outdated, true);
      assert.equal(review.sends(), 1);
    });
  }
});

test('conflicted selected index stages are one blocked file and gitlinks never send source', async t => {
  const { root, git, inputGit, source } = await repository(t);
  for (const name of ['safe.js', 'conflict.js']) await source(name);
  await git('add', '.');
  await git('commit', '-qm', 'fixture');
  const commit = (await git('rev-parse', 'HEAD')).toString('utf8').trim();
  const oid = inputGit(['hash-object', '-w', '--stdin'], 'conflict side\n');
  inputGit(['update-index', '--index-info'], '0 ' + '0'.repeat(40) + '	conflict.js\n' +
    [1, 2, 3].map(stage => '100644 ' + oid + ' ' + stage + '	conflict.js\n').join('') +
    '160000 ' + commit + '	submodule\n');
  await mkdir(path.join(root, 'submodule'));
  await source('submodule/private.js', 'DO NOT SEND SUBMODULE SOURCE');
  const selected = ['submodule', 'conflict.js', 'safe.js'];
  const inventory = await projectInventory(root, 'git', { selectedPaths: selected });
  assert.equal(inventory.records.length, 3, 'conflict stages must not inflate unique selected nodes');
  const batch = await captureProjectBatch(inventory, selected);
  selectedMetadata(batch.projectScope, 3);
  for (const name of ['conflict.js', 'submodule']) {
    const file = batch.files.find(file => file.path === name);
    if (name === 'conflict.js') assert.equal(file.eligibility, 'blocked', file.reason);
    else assert.ok(['excluded', 'blocked'].includes(file.eligibility), file.reason);
    assert.equal(file.right, undefined);
  }
  const review = reviewer(t, root, { onSend: request => {
    const input = JSON.parse(request.messages[0].content[0].text);
    assert.equal(input.file.path, 'safe.js');
    assert.ok(!JSON.stringify(input).includes('DO NOT SEND SUBMODULE SOURCE'));
  } });
  const preview = await review.preview(selected);
  selectedMetadata(preview, 3);
  assert.equal(preview.selectedFiles, 3);
  const unsafeFiles = preview.files.filter(file => file.path !== 'safe.js');
  assert.equal(unsafeFiles.length, 2);
  assert.ok(unsafeFiles.every(file => ['excluded', 'blocked'].includes(file.eligibility)));
  const { report } = await review.execute(preview);
  selectedMetadata(report, 3);
  assert.equal(report.coverage.total, 3);
  assert.equal(report.coverage.completed, 1);
  assert.equal(report.coverage.blocked + report.coverage.excluded, 2);
  assert.equal(report.coverage.pending, 0);
  assert.equal(report.status, 'partial');
  assert.equal(report.outdated, false);
  assert.equal(review.sends(), 1);
});
