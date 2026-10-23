import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewSnapshot } from '../src/review.mjs';
import { createDshModel } from '../src/dsh-model.mjs';
import { reviewProjectBatches } from '../src/project-execution.mjs';
import { changesConcurrency, retrievalRounds } from '../src/review-execution-policy.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const snapshot = n => ({ id: 'approved-svn', vcs: 'svn', history: { vcs: 'svn', baseRevision: '7363', targetRevision: '7364' }, context: [], files: Array.from({ length: n }, (_, i) => ({ id: 'f' + i, path: i + '.txt', eligibility: 'reviewable', properties: [], left: { text: 'old' + i }, right: { text: 'new' + i } })) });
const final = { findings: [], limitations: [] };
const candidate = p => ({ fileId: p.file.id, severity: 'high', title: 'candidate', evidence: 'untrusted analysis', trigger: 'input', impact: 'failure', suggestion: 'guard', anchor: { kind: 'file' } });

test('SVN independent chains overlap within a bound and merge candidate verdicts deterministically', async () => {
  async function run(concurrency) {
    let active = 0, peak = 0, calls = 0;
    const progress = [];
    const report = await reviewSnapshot(snapshot(5), async req => {
      calls++; active++; peak = Math.max(peak, active);
      const p = JSON.parse(req.input);
      await tick(); active--;
      if (p.candidates) return { verdicts: p.candidates.map(c => ({ candidateId: c.candidateId, verdict: 'uncertain', reason: 'runtime input unknown', evidence: [] })) };
      return { findings: [candidate(p)], limitations: [] };
    }, { changesConcurrency: concurrency, enableRetrieval: true, enableVerification: true, onProgress: e => progress.push(e) });
    assert.equal(progress.at(-1).stage, 'batch-complete');
    assert.equal(progress.filter(e => e.stage === 'file-complete').length, 5);
    assert.equal(new Set(progress.filter(e => e.stage === 'file-complete').map(e => e.file.fileId)).size, 5);
    return { report, calls, peak };
  }
  const serial = await run(1), parallel = await run(2), four = await run(4);
  assert.equal(serial.calls, 10); assert.equal(parallel.calls, 10);
  assert.equal(serial.peak, 1); assert.equal(parallel.peak, 2); assert.equal(four.peak, 4);
  assert.equal(four.calls, serial.calls); assert.deepEqual(four.report.findings, serial.report.findings);
  assert.deepEqual(parallel.report.findings, serial.report.findings);
  assert.deepEqual(parallel.report.files, serial.report.files);
});

test('shuffled completion keeps file and limitation order, actual completion events are independent', async () => {
  const gates = Array.from({ length: 4 }, defer), entered = [], events = [];
  const run = reviewSnapshot(snapshot(4), async req => {
    const p = JSON.parse(req.input), i = Number(p.file.path.split('.')[0]);
    entered.push(i); await gates[i].promise;
    return { findings: [], limitations: ['limitation' + i] };
  }, { changesConcurrency: 2, onProgress: e => events.push(e) });
  await tick(); assert.deepEqual(entered, [0, 1]);
  gates[1].resolve(); await tick(); assert.deepEqual(entered, [0, 1, 2]);
  assert.equal(events.find(e => e.stage === 'file-complete').file.fileId, 'f1');
  gates[2].resolve(); await tick(); gates[3].resolve(); gates[0].resolve();
  const result = await run;
  assert.deepEqual(result.files.map(f => f.fileId), ['f0', 'f1', 'f2', 'f3']);
  assert.deepEqual(result.limitations.map(l => l.text), ['limitation0', 'limitation1', 'limitation2', 'limitation3']);
});

test('business grouping runs once and interaction owner waits for all earlier members', async () => {
  const gate = defer(), started = [], completed = new Set(); let grouping = 0, interactions = 0;
  const run = reviewSnapshot(snapshot(4), async req => {
    const p = JSON.parse(req.input);
    if (!p.file && !p.sourceMode) { grouping++; return { groups: [{ fileIds: ['f0', 'f1', 'f2', 'f3'], reason: 'shared contract' }] }; }
    if (p.sourceMode === 'file-interaction') { interactions++; assert.ok(['f0', 'f1', 'f2'].every(id => completed.has(id))); return final; }
    started.push(p.file.id); if (p.file.id === 'f1') await gate.promise;
    completed.add(p.file.id); return final;
  }, { changesConcurrency: 2, enableRetrieval: true, enableBusinessGrouping: true });
  await tick(); assert.equal(grouping, 1); assert.ok(started.includes('f2')); assert.ok(!started.includes('f3'));
  gate.resolve(); const report = await run;
  assert.equal(interactions, 1); assert.equal(report.interactions[0].status, 'completed');
});

test('duplicate static and business groups never skip a primary file', async () => {
  const input = snapshot(2); input.files[0].path = 'a.h'; input.files[1].path = 'a.cpp';
  const primary = [];
  const report = await reviewSnapshot(input, req => {
    const p = JSON.parse(req.input); if (p.file) primary.push(p.file.id);
    return final;
  }, { changesConcurrency: 2, enableRetrieval: true, enableGrouping: true, enableBusinessGrouping: true });
  assert.deepEqual(primary, ['f0', 'f1']); assert.equal(report.modelCalls, 3);
  assert.equal(report.coverage.completed, 2); assert.equal(report.interactions.length, 1);
});

test('cancel drains both live chains and admits no new model request', async () => {
  const controller = new AbortController(), cleanup = [defer(), defer()]; let started = 0, cleaned = 0, settled = false;
  const run = reviewSnapshot(snapshot(5), async req => {
    const i = started++;
    await new Promise(resolve => req.signal.addEventListener('abort', resolve, { once: true }));
    await cleanup[i].promise; cleaned++; throw req.signal.reason;
  }, { changesConcurrency: 2, signal: controller.signal }).then(report => { settled = true; return report; });
  await tick(); assert.equal(started, 2); controller.abort(Error('cancel'));
  cleanup[0].resolve(); await tick(); assert.equal(settled, false);
  cleanup[1].resolve(); const report = await run;
  assert.equal(cleaned, 2); assert.equal(started, 2); assert.equal(report.status, 'cancelled');
  assert.ok(report.files.every(f => f.status === 'cancelled'));
});

test('fatal checkpoint failure aborts siblings and joins cleanup before rejecting', async () => {
  const cleanup = defer(); let entered = false, cleaned = false, settled = false;
  const error = Error('checkpoint failed');
  const run = reviewSnapshot(snapshot(4), async req => {
    entered = true; if (!req.signal.aborted) await new Promise(resolve => req.signal.addEventListener('abort', resolve, { once: true }));
    await cleanup.promise; cleaned = true; throw req.signal.reason;
  }, { changesConcurrency: 2, onProgress: async e => { if (e.stage === 'file-started' && e.fileId === 'f1') { await tick(); throw error; } } });
  const checked = assert.rejects(run, e => { settled = true; assert.equal(e, error); assert.ok(cleaned); return true; });
  await tick(); assert.ok(entered); assert.equal(settled, false); cleanup.resolve(); await checked;
});

test('shared reader remains one fifty-operation ledger under overlapping retrieval', async () => {
  const report = await reviewSnapshot(snapshot(2), async req => {
    const p = JSON.parse(req.input); await tick();
    if (p.retrievalFinalization) return final;
    return { requests: [{ kind: 'read', id: p.catalog.find(s => s.fileId === p.file.id && s.side === 'new').id, start: 1, count: 1 }] };
  }, { changesConcurrency: 2, enableRetrieval: true, maxRetrievalRounds: 50 });
  assert.equal(report.retrievalUsage.calls, 50);
  assert.ok(report.files.every(f => f.status !== 'completed'));
});

test('concurrent reads cannot multiply the shared output-byte budget', async () => {
  const input = snapshot(2);
  for (const file of input.files) { file.left.text = 'a'.repeat(10000); file.right.text = 'b'.repeat(10000); }
  const report = await reviewSnapshot(input, async req => {
    const p = JSON.parse(req.input); await tick();
    if (p.retrievalFinalization) return final;
    return { requests: [{ kind: 'read', id: p.catalog.find(s => s.fileId === p.file.id && s.side === 'new').id, start: 1, count: 1 }] };
  }, { changesConcurrency: 2, enableRetrieval: true, maxRetrievalRounds: 50, correctProtocol: true });
  assert.ok(report.retrievalUsage.outputBytes <= 256 * 1024);
  assert.ok(report.retrievalUsage.outputBytes > 240 * 1024);
  assert.ok(report.retrievalUsage.calls < 50);
  assert.equal(report.coverage.completed, 0);
  assert.ok(report.files.some(f => f.retrievalLimits?.some(l => l.code === 'READER_OUTPUT_BUDGET_EXCEEDED')));
});

test('falsy checkpoint rejection still cancels and rejects the whole run', async () => {
  let calls = 0, rejected = false;
  try { await reviewSnapshot(snapshot(2), () => { calls++; return final; }, { changesConcurrency: 2, onProgress: () => Promise.reject(undefined) }); }
  catch (error) { rejected = true; assert.equal(error, undefined); }
  assert.ok(rejected); assert.equal(calls, 0);
});

test('parallel JSON corrections cannot overspend shared model call cap', async () => {
  let sends = 0;
  const model = createDshModel({ async *stream() { sends++; await tick(); yield { type: 'text-delta', text: '{bad' }; yield { type: 'finish', reason: { kind: 'stop' } }; } }, { provider: 'p', model: 'm' }, { correctJson: true });
  const report = await reviewSnapshot(snapshot(4), model, { changesConcurrency: 2, maxCalls: 3 });
  assert.equal(sends, 3); assert.equal(report.modelCalls, 3); assert.equal(report.coverage.completed, 0);
});

test('policy bounds validate before sends and project workers honor nondefault rounds', async () => {
  for (const value of [0, 5, 1.1, NaN, '2']) assert.throws(() => changesConcurrency(value), /concurrency/);
  for (const value of [-1, 51, 1.1, NaN, '3']) assert.throws(() => retrievalRounds(value), /rounds/);
  assert.equal(changesConcurrency(), 2); assert.equal(retrievalRounds(), 3);
  const batch = { ...snapshot(1), projectScope: { mode: 'project' } }; let sends = 0;
  const reports = await reviewProjectBatches([batch], req => {
    sends++; const p = JSON.parse(req.input);
    if (p.retrievalFinalization) return final;
    return { requests: [{ kind: 'read', id: p.catalog[1].id, start: 1, count: 1 }] };
  }, { remainingCalls: () => 100 - sends, maxRetrievalRounds: 5 });
  assert.equal(sends, 6); assert.equal(reports[0].retrievalUsage.calls, 5);
  assert.equal(reports[0].execution.maxRetrievalRounds, 5);
});

test('actual provider lifecycle summaries count primary and verification without source payloads', async () => {
  const events = [];
  const model = createDshModel({ async *stream(req) {
    const p = JSON.parse(req.messages[0].content[0].text);
    const answer = p.candidates ? { verdicts: [{ candidateId: 'c1', verdict: 'uncertain', reason: 'counterevidence unresolved', evidence: [] }] } : { findings: [candidate(p)], limitations: [] };
    yield { type: 'text-delta', text: JSON.stringify(answer) };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } }, { provider: 'p', model: 'm' });
  const report = await reviewSnapshot(snapshot(1), model, { enableRetrieval: true, enableVerification: true, onProgress: e => events.push(e) });
  assert.equal(report.files[0].modelMetrics.primary.calls, 1);
  assert.equal(report.files[0].modelMetrics.verification.calls, 1);
  assert.equal(report.modelCalls, 2);
  for (const e of events.filter(e => e.action === 'model-start' || e.action === 'model-end')) {
    assert.equal(Object.hasOwn(e, 'input'), false); assert.equal(Object.hasOwn(e, 'text'), false);
    assert.equal(Object.hasOwn(e, 'reasoning'), false);
  }
  assert.equal(events.filter(e => e.action === 'model-end').length, 2);
});

test('production review round bound finalizes after three successful reads without fake completion', async () => {
  let calls = 0;
  const report = await reviewSnapshot(snapshot(1), req => {
    calls++; const p = JSON.parse(req.input);
    if (p.retrievalFinalization) return final;
    return { requests: [{ kind: 'read', id: p.catalog[1].id, start: 1, count: 1 }] };
  }, { enableRetrieval: true });
  assert.equal(calls, 4); assert.equal(report.retrievalUsage.calls, 3);
  assert.equal(report.files[0].status, 'pending'); assert.equal(report.status, 'partial');
});
