import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createReviewJobs } from '../src/review-jobs.mjs';

const history = () => ({
  ledger: { cycle: 1, snapshotId: 'prior-snapshot', findings: [{ id: 'finding-1', status: 'open' }] },
  manifest: { snapshotId: 'prior-snapshot', identity: { repository: 'repository-hash' }, files: [{ path: 'a.js', hash: 'source-hash' }] },
});
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-prior-job-'));
  const cwd = path.join(root, 'workspace'), directory = path.join(root, 'reports');
  await mkdir(cwd);
  const exec = { agent: { session: { header: { id: 'owner-session', cwd } }, options: { provider: 'provider', model: 'model', reasoningEffort: 'high' } } };
  const jobs = createReviewJobs({ directory });
  t.after(async () => { await jobs.dispose(); await rm(root, { recursive: true, force: true }); });
  return { cwd, directory, exec, jobs };
}
async function complete(f, result) {
  const started = await f.jobs.start(f.exec, async () => result);
  const waited = await f.jobs.wait(started.jobId, f.exec, { waitFor: 'terminal', timeoutMs: 5000 });
  assert.equal(waited.changed, true);
  assert.equal((await f.jobs.status(started.jobId, f.exec)).status, 'completed');
  return started.jobId;
}

test('owned completed current priorReview returns detached history metadata, never the old result or receipt', async t => {
  const f = await fixture(t), expected = history();
  const oldResult = { receipt: { approved: true, token: 'old-receipt-must-not-be-reused' }, report: { status: 'completed', reviewHistory: expected, findings: [{ title: 'old conclusion' }], sourceReceipts: [{ id: 'old-source-receipt' }] } };
  const id = await complete(f, oldResult);
  const prior = await f.jobs.priorReview(id, f.exec);
  assert.deepEqual(prior, expected);
  assert.deepEqual(Object.keys(prior).sort(), ['ledger', 'manifest']);
  for (const forbidden of ['receipt', 'report', 'sourceReceipts', 'result']) assert.equal(Object.hasOwn(prior, forbidden), false);
  prior.ledger.findings[0].status = 'mutated';
  prior.manifest.files[0].hash = 'mutated';
  assert.deepEqual(await f.jobs.priorReview(id, f.exec), expected);
  assert.deepEqual(oldResult.report.reviewHistory, expected);
  // A fresh service exercises the durable owned() path, not only the in-memory map.
  const fresh = createReviewJobs({ directory: f.directory });
  try { assert.deepEqual(await fresh.priorReview(id, f.exec), expected); }
  finally { await fresh.dispose(); }
});

test('active owned job cannot supply priorReview even when its work will produce history', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const started = await f.jobs.start(f.exec, async () => { entered.resolve(); await release.promise; return { report: { reviewHistory: history() } }; });
  try {
    await entered.promise;
    await assert.rejects(f.jobs.priorReview(started.jobId, f.exec), /terminal current review history unavailable/);
  } finally { release.resolve(); }
  await f.jobs.wait(started.jobId, f.exec, { waitFor: 'terminal', timeoutMs: 5000 });
  assert.deepEqual(await f.jobs.priorReview(started.jobId, f.exec), history());
});

test('persisted incomplete job states reject priorReview despite a history-shaped saved result', async t => {
  const f = await fixture(t), id = await complete(f, { report: { reviewHistory: history() } });
  const filename = path.join(f.directory, id + '.json');
  const completed = JSON.parse(await readFile(filename, 'utf8'));
  for (const status of ['queued', 'running', 'interrupted', 'failed', 'cancelled', 'partial']) {
    await writeFile(filename, JSON.stringify({ ...completed, status }));
    await assert.rejects(f.jobs.priorReview(id, f.exec), /terminal current review history unavailable/, status);
  }
});

test('completed outdated, missing-history and missing-result records reject priorReview', async t => {
  const f = await fixture(t), id = await complete(f, { report: { reviewHistory: history() } });
  const filename = path.join(f.directory, id + '.json');
  const completed = JSON.parse(await readFile(filename, 'utf8'));
  for (const result of [undefined, {}, { report: {} }, { report: { reviewHistory: null } }, { report: { reviewHistory: history(), outdated: true } }]) {
    await writeFile(filename, JSON.stringify({ ...completed, result }));
    await assert.rejects(f.jobs.priorReview(id, f.exec), /terminal current review history unavailable/);
  }
  await assert.rejects(f.jobs.priorReview(randomUUID(), f.exec), { code: 'ENOENT' });
});

test('priorReview rejects foreign session, provider, model, reasoning effort and cwd', async t => {
  const f = await fixture(t), id = await complete(f, { report: { reviewHistory: history() } });
  for (const mutate of [
    exec => { exec.agent.session.header.id = 'foreign-session'; },
    exec => { exec.agent.session.header.cwd = path.join(f.cwd, 'different'); },
    exec => { exec.agent.options.provider = 'other-provider'; },
    exec => { exec.agent.options.model = 'other-model'; },
    exec => { exec.agent.options.reasoningEffort = 'low'; },
  ]) {
    const foreign = structuredClone(f.exec); mutate(foreign);
    await assert.rejects(f.jobs.priorReview(id, foreign), /Foreign review job/);
  }
  assert.deepEqual(await f.jobs.priorReview(id, f.exec), history());
});
