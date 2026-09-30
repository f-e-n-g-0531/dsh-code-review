import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checked } from '../src/process.mjs';
import { createReviewService } from '../src/service.mjs';

test('real rule edits invalidate preview; denial prevents rule and source sending', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-rule-approval-'));
  t.after(async () => { assert.ok(path.basename(root).startsWith('review-rule-approval-')); await rm(root, { recursive: true, force: true }); });
  const git = (...args) => checked('git', args, { cwd: root });
  await git('init', '-q'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.invalid');
  await writeFile(path.join(root, 'a.js'), 'old'); await writeFile(path.join(root, 'rules.md'), 'Original rule');
  await git('add', '.'); await git('commit', '-qm', 'fixture');
  await writeFile(path.join(root, 'a.js'), 'new');
  let sends = 0, approvals = 0;
  const service = createReviewService({ stream() { sends++; throw Error('Unexpected send'); } }, {
    allowModelSending: true, authorize: async ({ snapshot }) => {
      approvals++; assert.equal(snapshot.rules[0].text, 'Changed rule'); return false;
    },
  });
  t.after(() => service.dispose());
  const exec = { agent: { session: { header: { cwd: root } }, options: { provider: 'offline', model: 'mock' } } };
  const first = await service.preview({ rulePaths: ['rules.md'] }, exec);
  await writeFile(path.join(root, 'rules.md'), 'Changed rule');
  await assert.rejects(service.execute({ previewId: first.previewId, confirmed: true }, exec), /changed since preview/);
  assert.equal(approvals, 0); assert.equal(sends, 0);
  const second = await service.preview({ rulePaths: ['rules.md'] }, exec);
  assert.notEqual(second.snapshotId, first.snapshotId);
  assert.notEqual(second.rules[0].hash, first.rules[0].hash);
  await assert.rejects(service.execute({ previewId: second.previewId, confirmed: true }, exec), /approval denied/);
  assert.equal(approvals, 1); assert.equal(sends, 0);
});
