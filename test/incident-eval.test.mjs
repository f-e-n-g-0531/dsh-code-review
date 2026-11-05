import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateIncidentRuns, validateIncidentManifest, validateIncidentReport, incidentReportDigest } from '../evaluation/incident-eval.mjs';

// Contract fixtures only: no production source, live review or expert gold asserted.
const identity = { snapshotId: 'fixture-snapshot', baseRevision: '1', targetRevision: '2', provider: 'fixture', model: 'fixture', runtimeVersion: 'fixture' };
const signed = { reviewer: 'fixture-expert', judgementRef: 'fixture-judgement' };
const expectation = (id, kind) => ({ id, kind, evidenceRefs: ['fixture-reference'] });
function incident(overrides = {}) {
  return { id: 'fixture-incident', identity: { ...identity }, runIds: ['a'], adjudication: { status: 'confirmed', ...signed }, expectations: [expectation('p', 'positive')], ...overrides };
}
const manifest = (...cases) => ({ version: 1, kind: 'real-incidents', cases });
function report(overrides = {}) {
  return { status: 'completed', snapshotId: identity.snapshotId, files: [{ fileId: 'f1', path: 'fixture.mjs', status: 'completed' }], findings: [], modelCalls: 3, ...overrides };
}
const finding = () => ({ fileId: 'f1', title: 'Fixture candidate', verification: { status: 'completed', verdict: 'supported', evidence: [{ status: 'references-validated' }] } });
function run(r = report(), overrides = {}) {
  return { caseId: 'fixture-incident', runId: 'a', identity: { ...identity }, jobStatus: 'completed', report: r, ...overrides };
}
const judge = (r, findingIndex, outcome, expectationId) => ({ findingIndex, reportSha256: incidentReportDigest(r), outcome, ...(expectationId ? { expectationId } : {}), ...signed, evidenceRefs: ['fixture-reference'] });

test('confirmed positive matches score only explicit expert judgements', () => {
  const r = report({ findings: [finding(), finding(), finding()] });
  const input = manifest(incident());
  const runs = [run(r, { judgements: [judge(r, 0, 'truePositive', 'p'), judge(r, 1, 'falsePositive')], elapsedMs: 12 })];
  const before = structuredClone({ input, runs });
  const result = evaluateIncidentRuns(input, runs);
  assert.equal(result.quality.precision, 0.5);
  assert.equal(result.quality.precisionDenominator, 2);
  assert.equal(result.quality.recall, 1);
  assert.equal(result.quality.unresolved, 1);
  assert.equal(result.operations.calls, 3);
  assert.equal(result.operations.elapsedMs, 12);
  assert.deepEqual({ input, runs }, before);
});

test('unadjudicated r7364-labelled hypothesis can never contribute gold', () => {
  const c = incident({ id: 'r7364-candidate-hypothesis', adjudication: { status: 'unadjudicated' } });
  const r = report({ findings: [finding()] });
  const result = evaluateIncidentRuns(manifest(c), [run(r, { caseId: c.id, judgements: [judge(r, 0, 'truePositive', 'p')] })]);
  assert.equal(result.quality.confirmedRuns, 0);
  assert.equal(result.quality.unadjudicatedRuns, 1);
  assert.equal(result.quality.truePositive, 0);
  assert.equal(result.quality.precision, null);
  assert.equal(result.quality.recall, null);
  assert.equal(result.operations.calls, 3);
});

test('all planned runs remain denominator including partial, failed, cancelled and missing', () => {
  const c = incident({ runIds: ['a', 'b', 'c', 'd', 'e'] });
  const r = report({ findings: [finding()] });
  const result = evaluateIncidentRuns(manifest(c), [
    run(r, { judgements: [judge(r, 0, 'truePositive', 'p')] }),
    run(report({ status: 'partial' }), { runId: 'b' }),
    run(null, { runId: 'c', jobStatus: 'failed' }),
    run(null, { runId: 'd', jobStatus: 'cancelled' }),
  ]);
  assert.equal(result.operations.plannedRuns, 5);
  assert.equal(result.operations.incompleteRuns, 4);
  assert.equal(result.operations.missingRuns, 1);
  assert.equal(result.quality.recallDenominator, 5);
  assert.equal(result.quality.recall, 0.2);
  assert.equal(result.runs.length, 5);
  assert.throws(() => evaluateIncidentRuns(manifest(c), [run(r), run(r)]), /duplicate/);
  assert.throws(() => evaluateIncidentRuns(manifest(c), [run(r, { runId: 'retry-best' })]), /unplanned/);
});

test('clean cases track harmful suggestions and unresolved findings across every run', () => {
  const c = incident({ runIds: ['a', 'b', 'c'], expectations: [expectation('n', 'negative'), expectation('h', 'harmful')] });
  const r = report({ status: 'partial', findings: [finding(), finding()] });
  const result = evaluateIncidentRuns(manifest(c), [run(r, { judgements: [judge(r, 0, 'harmful', 'h')] }), run(report(), { runId: 'b' })]);
  assert.equal(result.quality.cleanRuns, 3);
  assert.equal(result.quality.cleanRunsWithFindings, 1);
  assert.equal(result.quality.cleanRunsResolved, 1);
  assert.equal(result.quality.cleanHarmfulRate, 1 / 3);
  assert.equal(result.quality.cleanFalsePositiveRate, 1 / 3);
  assert.equal(result.quality.harmful, 1);
  assert.equal(result.quality.unresolved, 1);
  assert.equal(result.quality.precision, 0);
  assert.equal(result.quality.recall, null);
});

test('missing metrics stay unknown rather than measured zero', () => {
  const r = report(); delete r.modelCalls;
  const result = evaluateIncidentRuns(manifest(incident()), [run(r)]);
  assert.equal(result.operations.callsKnownRuns, 0);
  assert.equal(result.operations.elapsedKnownRuns, 0);
  assert.equal(result.quality.precision, null);
  assert.equal(result.quality.recall, 0);
});

test('runtime validator accepts actual host states but rejects invented statuses and page loss', () => {
  for (const status of ['completed', 'partial', 'failed', 'cancelled', 'interrupted', 'pending', 'running']) assert.doesNotThrow(() => validateIncidentReport(report({ status }), identity));
  for (const mutate of [r => r.status = 'clean', r => r.files[0].status = 'success', r => r.totalFiles = 2, r => r.totalFindings = 1, r => r.coverage = { completed: 0 }, r => r.files.push({ ...r.files[0] }), r => r.findings = [{ ...finding(), fileId: 'unknown' }], r => r.findings = [null], r => r.modelCalls = -1, r => r.diagnostics = { modelCalls: 99 }, r => r.outdated = 'false', r => r.files = null]) {
    const r = report(); mutate(r); assert.throws(() => validateIncidentReport(r, identity));
  }
});

test('fixed identity mismatch is fatal even for unadjudicated and incomplete reports', () => {
  for (const k of Object.keys(identity)) {
    const observed = { ...identity, [k]: 'drift' };
    assert.throws(() => evaluateIncidentRuns(manifest(incident()), [run(null, { identity: observed, jobStatus: 'failed' })]), /identity mismatch/);
  }
  for (const patch of [{ snapshotId: 'other' }, { model: { provider: 'other' } }, { model: { model: 'other' } }, { runtime: { version: 'other' } }, { history: { base: 'other' } }, { history: { target: 'other' } }]) assert.throws(() => validateIncidentReport(report(patch), identity), /identity mismatch/);
});

test('completion is not inferred from completed headline with unfinished stages or stale source', () => {
  for (const patch of [{ outdated: true }, { files: [{ fileId: 'f1', path: 'fixture.mjs', status: 'pending' }] }, { stageContinuation: { pending: 1 } }, { interactions: [{ status: 'pending' }] }, { findings: [{ fileId: 'f1', title: 'Unverified' }] }]) {
    const result = evaluateIncidentRuns(manifest(incident()), [run(report(patch))]);
    assert.equal(result.operations.completeRuns, 0);
    assert.equal(result.operations.incompleteRuns, 1);
  }
});

test('case contract requires expert confirmation, references, unique identities and metadata only', () => {
  for (const mutate of [c => delete c.adjudication.reviewer, c => c.adjudication.status = 'gold', c => c.expectations[0].evidenceRefs = [], c => c.expectations.push({ ...c.expectations[0] }), c => c.identity.apiKey = 'forbidden', c => c.source = 'forbidden', c => c.lifecycleOutcome = 'fixed', c => c.expectations = []]) {
    const c = incident(); mutate(c); assert.throws(() => validateIncidentManifest(manifest(c)));
  }
  assert.throws(() => validateIncidentManifest(manifest(incident(), incident())), /unique case/);
  for (const lifecycleOutcome of ['fix', 'wrong', 'intentional', 'not-worth']) assert.doesNotThrow(() => validateIncidentManifest(manifest(incident({ lifecycleOutcome, causeCluster: 'fixture-cause' }))));
});

test('finding judgements cannot be transplanted, unsigned, duplicated or multiply match gold', () => {
  const r = report({ findings: [finding(), finding()] });
  for (const mutate of [j => j.findingIndex = 4, j => j.reportSha256 = '0'.repeat(64), j => delete j.reviewer, j => j.expectationId = 'unknown', j => j.outcome = 'supported', j => j.evidenceRefs = [], j => j.source = 'forbidden']) {
    const j = judge(r, 0, 'truePositive', 'p'); mutate(j);
    assert.throws(() => evaluateIncidentRuns(manifest(incident()), [run(r, { judgements: [j] })]));
  }
  const j = judge(r, 0, 'truePositive', 'p');
  assert.throws(() => evaluateIncidentRuns(manifest(incident()), [run(r, { judgements: [j, j] })]), /finding index/);
  assert.throws(() => evaluateIncidentRuns(manifest(incident()), [run(r, { judgements: [j, judge(r, 1, 'truePositive', 'p')] })]), /unique positive/);
});

test('aggregate does not publish injected report text, references or expert identity', () => {
  const r = report({ findings: [{ ...finding(), title: 'PRIVATE SOURCE MARKER' }] });
  const result = JSON.stringify(evaluateIncidentRuns(manifest(incident()), [run(r, { judgements: [judge(r, 0, 'truePositive', 'p')] })]));
  for (const secret of ['PRIVATE SOURCE MARKER', 'fixture-judgement', 'fixture-reference', 'fixture-expert']) assert.ok(!result.includes(secret));
});

test('JSON schema exposes manifest/run/judgement contracts without fixture source', async () => {
  const schema = JSON.parse(await readFile(new URL('../evaluation/incidents.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.$defs.incident.additionalProperties, false);
  assert.deepEqual(schema.$defs.run.properties.jobStatus.enum, ['completed', 'failed', 'cancelled', 'interrupted']);
  assert.ok(schema.$defs.judgement.required.includes('reportSha256'));
});
