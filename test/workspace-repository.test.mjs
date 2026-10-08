import test from 'node:test';
import assert from 'node:assert/strict';
import { xml } from '../src/svn.mjs';
import { checked } from '../src/process.mjs';
import { pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, rm, symlink, writeFile, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveWorkspaceRepository as resolve } from '../src/workspace-repository.mjs';
import { createReviewService } from '../src/service.mjs';
test('real Git and SVN children review independently and preserve working status', async t => {
 const root = await mkdtemp(path.join(os.tmpdir(), 'review-workspace-'));
 t.after(async () => { assert.ok(path.basename(root).startsWith('review-workspace-')); await rm(root, { recursive: true, force: true }); });
 const git = path.join(root, 'git-child'), svn = path.join(root, 'svn-child');
 await mkdir(git); await checked('git', ['init'], { cwd: git });
 await writeFile(path.join(git, 'a.js'), 'before');
 await checked('git', ['add', '.'], { cwd: git });
 await checked('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'base'], { cwd: git });
 await writeFile(path.join(git, 'a.js'), 'after');
 const store = path.join(root, 'store'); await checked('svnadmin', ['create', store]);
 await checked('svn', ['checkout', '--non-interactive', pathToFileURL(store).href, svn]);
 await writeFile(path.join(svn, 'b.js'), 'before');
 await checked('svn', ['add', 'b.js'], { cwd: svn });
 await checked('svn', ['commit', '-m', 'base', '--non-interactive'], { cwd: svn });
 await writeFile(path.join(svn, 'b.js'), 'after');
 let calls = 0, approvedRoot;
 const service = createReviewService({ async *stream() { assert.ok(approvedRoot); calls++; yield { type: 'text-delta', text: JSON.stringify({ findings: [], limitations: [] }) }; yield { type: 'finish', reason: { kind: 'stop' } }; } }, { allowModelSending: true, authorize: async ({ snapshot }) => { approvedRoot = snapshot.root; return true; } });
 t.after(() => service.dispose());
 const exec = { agent: { session: { header: { cwd: root } }, options: { provider: 'test', model: 'offline' } } };
 for (const [repositoryPath, target, type] of [['git-child', git, 'git'], ['svn-child', svn, 'svn']]) {
  const args = type === 'git' ? ['status', '--porcelain=v1'] : ['status', '--xml'];
  const before = await checked(type, args, { cwd: target });
  const preview = await service.preview({ repositoryPath }, exec);
  assert.equal(preview.vcs, type); assert.equal(calls, type === 'git' ? 0 : 1);
  const result = await service.execute({ previewId: preview.previewId, confirmed: true }, exec);
  assert.equal(result.report.status, 'completed'); assert.equal(result.report.outdated, false);
  assert.equal(approvedRoot, target);
  const after = await checked(type, args, { cwd: target });
  assert.deepEqual(type === 'svn' ? xml(after) : after, type === 'svn' ? xml(before) : before);
 }
 const preview = await service.preview({ repositoryPath: 'git-child' }, exec);
 await rename(git, path.join(root, 'moved'));
 await symlink(path.join(root, 'moved'), git, 'junction');
 await assert.rejects(service.execute({ previewId: preview.previewId, confirmed: true }, exec), /directory|link/);
 assert.equal(calls, 2);
});
test('workspace sibling repositories can be independently selected without changing session cwd', async () => {
 const root = await mkdtemp(path.join(os.tmpdir(), 'review-workspace-'));
 try {
  for (const name of ['a', 'b']) await mkdir(path.join(root, name, '.git'), { recursive: true });
  const captured = [];
  const service = createReviewService({}, { capture: async cwd => { captured.push(cwd); return { id: cwd, root: cwd, vcs: 'git', files: [], context: [] }; } });
  const exec = { agent: { session: { header: { cwd: root } }, options: { provider: 'p', model: 'm' } } };
  const a = await service.preview({ repositoryPath: 'a' }, exec), b = await service.preview({ repositoryPath: 'b' }, exec);
  assert.notEqual(a.previewId, b.previewId);
  assert.equal(a.repositoryRoot, path.join(root, 'a')); assert.equal(b.repositoryRoot, path.join(root, 'b'));
  assert.equal(exec.agent.session.header.cwd, root); service.dispose();
  for (const name of ['../escape', '/absolute', 'a/..', 'a/.git', 'missing']) await assert.rejects(resolve(root, name));
  await mkdir(path.join(root, 'plain')); await assert.rejects(resolve(root, 'plain'), /repository root/);
  await symlink(path.join(root, 'a'), path.join(root, 'linked'), 'junction');
  await assert.rejects(resolve(root, 'linked'), /real workspace directory|link/);
 } finally { await rm(root, { recursive: true, force: true }); }
});
