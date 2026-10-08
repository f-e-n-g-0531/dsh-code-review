import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveWorkspaceRepository as resolve } from '../src/workspace-repository.mjs';
import { createReviewService } from '../src/service.mjs';
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
