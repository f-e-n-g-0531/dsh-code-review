import test from 'node:test';
import assert from 'node:assert/strict';
import { checked } from '../src/process.mjs';
import { writeFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildResumeState, validateResumeState } from '../src/review-resume.mjs';
import { createReviewService } from '../src/service.mjs';
import { createReviewJobs } from '../src/review-jobs.mjs';
import { registerBackgroundReview } from '../src/background-review.mjs';
const snapshot = () => ({ id: 'snapshot', vcs: 'git', root: '/repo', files: ['a', 'b'].map(id => ({ id, path: id + '.js', eligibility: 'reviewable', left: { text: 'export const x = 1;\n' }, right: { text: 'export const x = 2;\n' }, properties: [] })), context: [{ path: 'dep.js', text: 'dependency' }], rules: [{ path: 'rules.md', text: 'rule' }], businessRequirement: 'requirement' });
const identity = () => ({ captureOptions: {}, route: { provider: 'test', model: 'm' }, runtime: { version: 'fixture' }, execution: { rounds: 1, enableGroupPrimary: false } });
const report = () => ({ files: snapshot().files.map(file => ({ fileId: file.id, path: file.path, status: 'completed', resumeEligible: true })), findings: [{ id: 'candidate', fileId: 'a', status: 'refuted', verification: { status: 'completed', verdict: 'refuted', evidence: [{ receiptId: 'old-receipt', sourceId: 's1' }] } }], limitations: [{ fileId: 'a', text: 'prior limitation' }], interactions: [] });
const exec = (id = 'owner') => ({ agent: { session: { header: { id, cwd: '/repo' } }, options: { provider: 'test', model: 'm' } }, signal: new AbortController().signal });
const llm = counter => ({ async *stream() { counter.calls++; yield { type: 'text-delta', text: '{"findings":[],"limitations":[]}' }; yield { type: 'finish', reason: { kind: 'stop' } }; } });
const wait = async (jobs, id, e) => { for (;;) { const state = await jobs.status(id, e); if (!['running', 'queued'].includes(state.status)) return state; await jobs.wait(id, e, { after: state.waitRevision, waitFor: 'terminal', timeoutMs: 1000 }); } };

test('state retains all accepted finding verdicts and limitations; clone cannot mutate checkpoint', () => {
 const s = snapshot(), options = identity(), checkpoint = report(), state = buildResumeState(s, options, checkpoint);
 assert.equal(state.completed.length, 2); assert.equal(state.completed[0].findings[0].status, 'refuted');
 assert.equal(state.completed[0].limitations[0].text, 'prior limitation'); checkpoint.files[0].status = 'pending';
 const valid = validateResumeState(state, s, options); valid.completed[0].findings[0].status = 'supported';
 assert.equal(state.completed[0].findings[0].status, 'refuted');
});
test('whole source/context/rules/requirements/selection/route/runtime/config identity must match even reused snapshot ID', () => {
 const original = snapshot(), options = identity(), state = buildResumeState(original, options, report());
 for (const mutate of [s => { s.files[0].right.text += '!'; }, s => { s.files[0].left.text += '!'; }, s => { s.context[0].text += '!'; }, s => { s.rules[0].text += '!'; }, s => { s.businessRequirement += '!'; }, s => { s.files.reverse(); }]) {
  const changed = structuredClone(original); mutate(changed); assert.throws(() => validateResumeState(state, changed, options), /identity mismatch/);
 }
 for (const mutate of [o => { o.route.model = 'different'; }, o => { o.route.reasoningEffort = 'high'; }, o => { o.runtime.version = 'other'; }, o => { o.execution.rounds = 2; }, o => { o.execution.enableGroupPrimary = true; }, o => { o.captureOptions.selectedPaths = ['a.js']; }]) {
  const changed = identity(); mutate(changed); assert.throws(() => validateResumeState(state, original, changed), /identity mismatch/);
 }
});
test('partial unverified synthesis-limited or interaction-owned chains never reusable', () => {
 for (const mutate of [r => { r.files[0].status = 'pending'; }, r => { delete r.files[0].resumeEligible; }, r => { r.files[0].retrievalLimited = true; }, r => { r.files[0].synthesisStatus = 'pending'; }, r => { r.findings[0].verification.status = 'failed'; }, r => { r.interactions = [{ fileIds: ['a', 'b'], status: 'pending' }]; }]) {
  const r = report(); mutate(r); assert.ok(!buildResumeState(snapshot(), identity(), r).completed.some(item => item.fileId === 'a'));
 }
});
test('latest successful synthesis never hides an earlier failed pass or pending original window', () => {
 const mutations = [
  state => { state.stageFailures = [{ phase: 'synthesis', status: 'failed', round: 1 }]; },
  state => { state.reviewPasses = [{ phase: 'synthesis', status: 'failed', round: 1 }, { phase: 'synthesis', status: 'completed', round: 2 }]; },
  state => { state.reviewPasses = [{ status: 'pending', round: 1 }, { status: 'completed', round: 2 }]; },
  state => { state.windowCoverage = { completed: ['w2'], pending: ['w1'] }; },
  state => { state.stageFailures = [{ phase: 'synthesis', status: 'failed', round: 1 }]; state.reviewPasses = [{ status: 'failed', round: 1 }, { status: 'completed', round: 2 }]; },
 ];
 for (const mutate of mutations) {
  const checkpoint = report();
  checkpoint.files[0].synthesisStatus = 'completed';
  // The old eligibility bit deliberately remains true: neither builder nor
  // validator may trust it over incomplete original-round/window coverage.
  mutate(checkpoint.files[0]);
  const built = buildResumeState(snapshot(), identity(), checkpoint);
  assert.deepEqual(built.completed.map(item => item.fileId), ['b']);
  const forged = buildResumeState(snapshot(), identity(), report());
  forged.completed[0].state.synthesisStatus = 'completed'; mutate(forged.completed[0].state);
  assert.throws(() => validateResumeState(forged, snapshot(), identity()), /Invalid completed resume chain/);
 }
 const complete = report(); Object.assign(complete.files[0], { synthesisStatus: 'completed', stageFailures: [], reviewPasses: [{ status: 'completed', round: 1 }, { status: 'completed', round: 2 }], windowCoverage: { completed: ['w1', 'w2'], pending: [] } });
 const state = buildResumeState(snapshot(), identity(), complete);
 assert.deepEqual(state.completed.map(item => item.fileId), ['a', 'b']);
 assert.equal(validateResumeState(state, snapshot(), identity()).completed.length, 2);
});

test('forged source/state IDs, duplicate entries, incomplete findings and limitations fail validation', () => {
 for (const mutate of [r => { r.completed[0].state.fileId = 'b'; }, r => { r.completed[0].path = 'other'; }, r => { r.completed[0].fileId = 'foreign'; }, r => { r.completed[1] = r.completed[0]; }, r => { r.completed[0].state.resumeEligible = false; }, r => { r.completed[0].findings[0].fileId = 'b'; }, r => { r.completed[0].findings[0].verification.status = 'pending'; }, r => { r.completed[0].limitations[0].fileId = 'b'; }]) {
  const state = buildResumeState(snapshot(), identity(), report()); mutate(state); assert.throws(() => validateResumeState(state, snapshot(), identity()), /Invalid completed/);
 }
});
test('service fresh preview resumes identical completed chains without calls but requires new confirmation and authorization', async () => {
 const counter = { calls: 0 }, e = exec(); let saved, approvals = 0;
 const service = createReviewService(llm(counter), { capture: async () => snapshot(), allowModelSending: true, authorize: async () => { approvals++; return true; } });
 e.reviewResumeCheckpoint = async state => { saved = state; };
 const first = await service.preview({}, e); await service.execute({ previewId: first.previewId, confirmed: true }, e);
 assert.equal(counter.calls, 2); assert.equal(saved.completed.length, 2); e.resolveReviewResume = async () => saved;
 const preview = await service.preview({ resumeFromJobId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }, e);
 assert.equal(preview.resume.reusableFiles, 2); assert.equal(counter.calls, 2);
 await assert.rejects(service.execute({ previewId: preview.previewId }, e), /Confirmed preview/);
 const result = await service.execute({ previewId: preview.previewId, confirmed: true }, e);
 assert.equal(counter.calls, 2); assert.equal(approvals, 2); assert.equal(result.report.modelCalls, 0);
 assert.equal(result.report.resume.reusedFiles, 2); assert.ok(result.report.files.every(file => file.reused)); service.dispose();
});
test('service does not reuse after changed context/config or bypass denial and execute freshness', async () => {
 const e = exec(), counter = { calls: 0 }; let saved, source = snapshot(), allowed = true;
 const service = createReviewService(llm(counter), { capture: async () => structuredClone(source), allowModelSending: true, authorize: async () => allowed });
 e.reviewResumeCheckpoint = async state => { saved = state; }; const p = await service.preview({}, e); await service.execute({ previewId: p.previewId, confirmed: true }, e); e.resolveReviewResume = async () => saved;
 source.context[0].text = 'different'; await assert.rejects(service.preview({ resumeFromJobId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }, e), /identity mismatch/);
 source = snapshot(); const next = await service.preview({ resumeFromJobId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }, e); allowed = false;
 await assert.rejects(service.execute({ previewId: next.previewId, confirmed: true }, e), /denied/); assert.equal(counter.calls, 2); service.dispose();
});
test('durable safe checkpoints survive cancellation and restart, remain private and owner exact', async t => {
 const directory = await mkdtemp(path.join(os.tmpdir(), 'resume-job-')); t.after(() => rm(directory, { recursive: true, force: true }));
 const jobs = createReviewJobs({ directory }), e = exec(); let entered; const ready = new Promise(resolve => { entered = resolve; });
 const state = buildResumeState(snapshot(), identity(), report());
 const started = await jobs.start(e, async ({ saveResumeState, signal }) => { await saveResumeState(state); entered(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); throw signal.reason; });
 await ready; await assert.rejects(jobs.resume(started.jobId, e), /No terminal/); assert.ok(!JSON.stringify(await jobs.status(started.jobId, e)).includes('old-receipt'));
 await jobs.cancel(started.jobId, e); await wait(jobs, started.jobId, e); await jobs.dispose();
 const fresh = createReviewJobs({ directory }); assert.deepEqual(await fresh.resume(started.jobId, e), state);
 for (const other of [exec('foreign'), exec()]) { if (other.agent.session.header.id === 'owner') other.agent.options.reasoningEffort = 'high'; await assert.rejects(fresh.resume(started.jobId, other), /Foreign/); } await fresh.dispose();
});
test('completed business partitions and only jointly reusable interactions survive validated state', () => {
 const r = report(); r.businessGrouping = { status: 'completed', groups: [{ id: 'b1', fileIds: ['a', 'b'], reason: 'joint', confidence: 'model-hypothesis' }], links: [] };
 r.interactions = [{ id: 'i1', fileIds: ['a', 'b'], status: 'completed' }];
 const state = buildResumeState(snapshot(), identity(), r);
 assert.equal(state.businessGrouping.groups[0].id, 'b1'); assert.equal(state.interactions.length, 1);
 validateResumeState(state, snapshot(), identity());
 state.businessGrouping.groups[0].fileIds = ['a']; assert.throws(() => validateResumeState(state, snapshot(), identity()), /Missing business group member/);
 r.files[1].status = 'pending'; assert.equal(buildResumeState(snapshot(), identity(), r).interactions.length, 0);
});

test('project mode resumes completed chains with fresh approval and rejects same inventory with changed body', async t => {
 const root = await mkdtemp(path.join(os.tmpdir(), 'resume-project-')); t.after(() => rm(root, { recursive: true, force: true }));
 const git = (...args) => checked('git', args, { cwd: root });
 await git('init', '-q'); await git('config', 'user.name', 'test'); await git('config', 'user.email', 'test@example.invalid');
 await writeFile(path.join(root, 'main.js'), 'export const x = 1;\n'); await git('add', '.'); await git('commit', '-qm', 'base');
 const e = exec(); e.agent.session.header.cwd = root; const counter = { calls: 0 }; let state, approvals = 0;
 e.reviewResumeCheckpoint = async value => { state = value; }; e.resolveReviewResume = async () => state;
 const service = createReviewService(llm(counter), { allowModelSending: true, authorize: async () => { approvals++; return true; } }); t.after(() => service.dispose());
 const p = await service.preview({ reviewMode: 'project' }, e); await service.execute({ previewId: p.previewId, confirmed: true }, e);
 assert.equal(state.mode, 'project'); assert.equal(state.batches[0].completed.length, 1); assert.equal(counter.calls, 1);
 const next = await service.preview({ reviewMode: 'project', resumeFromJobId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }, e);
 assert.equal(next.resume.reusableFiles, 1); const r = await service.execute({ previewId: next.previewId, confirmed: true }, e);
 assert.equal(counter.calls, 1); assert.equal(approvals, 2); assert.equal(r.report.modelCalls, 0); assert.equal(r.report.files[0].reused, true);
 await writeFile(path.join(root, 'main.js'), 'export const x = 2;\n');
 await assert.rejects(service.preview({ reviewMode: 'project', resumeFromJobId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }, e), /identity mismatch/);
});

test('cancelled multi-file review checkpoint reuses only safely completed file on fresh run', async () => {
 const controller = new AbortController(), e = exec(); e.signal = controller.signal; let state; const counter = { calls: 0 };
 const service = createReviewService(llm(counter), { capture: async () => snapshot(), changesConcurrency: 1, allowModelSending: true, authorize: async () => true });
 e.reviewResumeCheckpoint = async value => { state = value; if (value.completed.length === 1) controller.abort(Error('stop after completed')); };
 const p = await service.preview({}, e); const first = await service.execute({ previewId: p.previewId, confirmed: true }, e);
 assert.equal(first.report.status, 'cancelled'); assert.equal(state.completed.length, 1); assert.equal(counter.calls, 1);
 e.signal = new AbortController().signal; e.resolveReviewResume = async () => state; e.reviewResumeCheckpoint = async value => { state = value; };
 const next = await service.preview({ resumeFromJobId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }, e);
 const r = await service.execute({ previewId: next.previewId, confirmed: true }, e); assert.equal(counter.calls, 2); assert.equal(r.report.resume.reusedFiles, 1); assert.equal(r.report.files.filter(file => file.reused).length, 1); service.dispose();
});

test('background resolves private source state and saves artifact refs not raw blocks in public jobs', async t => {
 const directory = await mkdtemp(path.join(os.tmpdir(), 'resume-bg-')); t.after(() => rm(directory, { recursive: true, force: true })); const e = exec(); const state = buildResumeState(snapshot(), identity(), report());
 const definitions = []; const jobs = registerBackgroundReview({ tools: { register: definition => definitions.push(definition) }, on() {} }, { preview: async (_args, context) => { const restored = await context.resolveReviewResume(_args.resumeFromJobId); assert.deepEqual(restored, state); return { previewId: 'fresh' }; }, execute: async (_args, context) => { await context.reviewResumeCheckpoint(state); const ref = await context.onModelArtifact({ status: 'completed', blocks: [{ type: 'text', text: 'PRIVATE-RAW' }] }); return { report: { status: 'completed', files: [], findings: [], artifacts: [ref] } }; } }, { directory });
 const start = definitions.find(tool => tool.name === 'code_review_start'); const first = JSON.parse((await start.execute({ phase: 'execute', previewId: 'approved', confirmed: true }, e)).json);
 const done = await wait(jobs, first.jobId, e); assert.ok(!JSON.stringify(done).includes('PRIVATE-RAW')); assert.equal(done.artifacts.length, 1);
 const privatePage = await jobs.artifacts(first.jobId, e, {}); assert.equal(privatePage.artifacts[0].artifact.blocks[0].text, 'PRIVATE-RAW');
 const second = JSON.parse((await start.execute({ phase: 'preview', previewArgs: { resumeFromJobId: first.jobId } }, e)).json); assert.equal((await wait(jobs, second.jobId, e)).result.previewId, 'fresh'); await jobs.dispose();
});
