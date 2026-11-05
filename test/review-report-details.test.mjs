import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerBackgroundReview } from '../src/background-review.mjs';

const BRIEF = ['# Brief saved report', 'User-facing summary only.'].join(String.fromCharCode(10));
const FULL = ['# Technical saved report', 'TECHNICAL_DETAIL_SENTINEL_7603', 'Detailed evidence bytes. '.repeat(1024)].join(String.fromCharCode(10));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t, { hold = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-report-details-'));
  const cwd = path.join(root, 'workspace'), directory = path.join(root, 'host-reports');
  await mkdir(cwd);
  const definitions = [], release = deferred(), entered = deferred();
  let executeCalls = 0;
  const result = { report: { status: 'completed', files: [], findings: [], limitations: [], coverage: { completed: 0 } }, markdown: BRIEF, technicalMarkdown: FULL };
  // Only tool declaration context and business service are mocks. Registration
  // creates the real createReviewJobs store and persists to a real temp directory.
  // No LLM runtime/provider is installed; these fixtures never dispatch a model.
  const jobs = registerBackgroundReview({ tools: { register: tool => definitions.push(tool) }, on() {} }, {
    async execute() { executeCalls++; entered.resolve(); if (hold) await release.promise; return result; },
    async preview() { assert.fail('detail reads must not start preview'); },
  }, { directory });
  t.after(async () => { release.resolve(); await jobs.dispose(); await rm(root, { recursive: true, force: true }); });
  const exec = { agent: { session: { header: { id: 'detail-owner', cwd } }, options: { provider: 'offline-fixture', model: 'no-provider' } } };
  const tool = name => definitions.find(d => d.name === 'code_review_' + name);
  const started = JSON.parse((await tool('start').execute({ phase: 'execute', previewId: 'owned-approved-fixture', confirmed: true }, exec)).json);
  await entered.promise;
  if (!hold) await jobs.wait(started.jobId, exec, { waitFor: 'terminal', timeoutMs: 5000 });
  return { jobs, exec, id: started.jobId, tool, release, executeCalls: () => executeCalls };
}
function noTechnicalBytes(output) {
  const serialized = JSON.stringify(output);
  assert.ok(!serialized.includes('TECHNICAL_DETAIL_SENTINEL_7603'));
  assert.ok(!serialized.includes('Detailed evidence bytes.'));
  assert.ok(!serialized.includes('technicalMarkdown'));
}

test('default terminal wait returns stored brief report without technical content or technical bytes', async t => {
  const f = await fixture(t);
  const output = await f.tool('wait').execute({ jobId: f.id, waitFor: 'terminal', timeoutMs: 1 }, f.exec);
  assert.equal(output.markdown, BRIEF);
  assert.equal(JSON.parse(output.json).finalMarkdown, BRIEF);
  assert.equal(JSON.parse(output.json).status, 'completed');
  noTechnicalBytes(output);
  assert.equal(f.executeCalls(), 1);
});

test('technical status explicitly returns the complete saved report without rerunning execution', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.tool('status').parameters.properties.detail.enum, ['summary', 'technical']);
  const saved = await f.jobs.status(f.id, f.exec);
  assert.equal(saved.result.technicalMarkdown, FULL);
  const summary = await f.tool('status').execute({ jobId: f.id }, f.exec);
  noTechnicalBytes(summary);
  const output = await f.tool('status').execute({ jobId: f.id, detail: 'technical' }, f.exec);
  assert.equal(output.markdown, FULL);
  assert.equal(JSON.parse(output.json).finalMarkdown, FULL);
  assert.equal(Buffer.byteLength(output.markdown), Buffer.byteLength(FULL));
  assert.equal(f.executeCalls(), 1);
  const again = await f.tool('status').execute({ jobId: f.id, detail: 'technical' }, f.exec);
  assert.equal(again.markdown, FULL);
  assert.equal(f.executeCalls(), 1);
});

test('unknown detail is rejected and saved summary or technical report requires exact owner', async t => {
  const f = await fixture(t);
  for (const detail of ['full', '', null, 1]) {
    await assert.rejects(f.tool('status').execute({ jobId: f.id, detail }, f.exec), /Invalid report detail/);
  }
  const foreign = structuredClone(f.exec); foreign.agent.session.header.id = 'foreign-session';
  for (const detail of ['summary', 'technical']) {
    await assert.rejects(f.tool('status').execute({ jobId: f.id, detail }, foreign), /Foreign review job/);
  }
  await assert.rejects(f.tool('wait').execute({ jobId: f.id, waitFor: 'terminal', timeoutMs: 1 }, foreign), /Foreign review job/);
  assert.equal(f.executeCalls(), 1);
});

test('running job cannot expose a final brief or technical report', async t => {
  const f = await fixture(t, { hold: true });
  for (const detail of [undefined, 'summary', 'technical']) {
    const output = await f.tool('status').execute({ jobId: f.id, ...(detail ? { detail } : {}) }, f.exec);
    assert.equal(JSON.parse(output.json).status, 'running');
    assert.equal(JSON.parse(output.json).finalMarkdown, undefined);
    noTechnicalBytes(output);
    assert.ok(!JSON.stringify(output).includes(BRIEF));
  }
  const waiting = await f.tool('wait').execute({ jobId: f.id, waitFor: 'terminal', timeoutMs: 1 }, f.exec);
  assert.equal(JSON.parse(waiting.json).changed, false);
  assert.equal(JSON.parse(waiting.json).status, 'running');
  noTechnicalBytes(waiting);
  assert.equal(f.executeCalls(), 1);
  f.release.resolve();
  await f.jobs.wait(f.id, f.exec, { waitFor: 'terminal', timeoutMs: 5000 });
  assert.equal((await f.tool('status').execute({ jobId: f.id, detail: 'technical' }, f.exec)).markdown, FULL);
  assert.equal(f.executeCalls(), 1);
});
