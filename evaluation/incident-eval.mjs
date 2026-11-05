// Offline, metadata-only scoring of supplied expert judgements. No source/model IO.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { reportSummaryData } from '../src/report-summary.mjs';

const REPORT_STATES = ['completed', 'partial', 'failed', 'cancelled', 'interrupted', 'pending', 'running'];
const FILE_STATES = ['completed', 'excluded', 'blocked', 'failed', 'cancelled', 'pending', 'running', 'interrupted'];
const IDENTITY = ['snapshotId', 'baseRevision', 'targetRevision', 'provider', 'model', 'runtimeVersion'];
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 4096;
const count = v => Number.isSafeInteger(v) && v >= 0;
function check(ok, label) { if (!ok) throw new Error('Invalid incident evaluation: ' + label); }
function keys(value, allowed, label) {
  check(object(value) && Object.keys(value).every(k => allowed.includes(k)), label);
}
function strings(value, label, nonempty = true) {
  check(Array.isArray(value) && (!nonempty || value.length > 0) && value.length <= 10000 && value.every(text) && new Set(value).size === value.length, label);
}
function signature(value) {
  keys(value, ['reviewer', 'judgementRef'], 'expert signature');
  check(text(value.reviewer) && text(value.judgementRef), 'expert signature');
}
function identity(value) {
  keys(value, IDENTITY, 'fixed identity');
  check(IDENTITY.every(k => text(value[k])), 'fixed identity');
}

export function validateIncidentManifest(manifest) {
  keys(manifest, ['version', 'kind', 'cases'], 'manifest');
  check(manifest.version === 1 && manifest.kind === 'real-incidents' && Array.isArray(manifest.cases) && manifest.cases.length > 0 && manifest.cases.length <= 200, 'manifest version/kind/cases');
  const ids = new Set();
  for (const c of manifest.cases) {
    keys(c, ['id', 'identity', 'runIds', 'adjudication', 'expectations', 'causeCluster', 'lifecycleOutcome'], 'case');
    check(text(c.id) && !ids.has(c.id), 'unique case id'); ids.add(c.id);
    identity(c.identity); strings(c.runIds, 'planned runIds');
    keys(c.adjudication, ['status', 'reviewer', 'judgementRef'], 'case adjudication');
    check(['confirmed', 'unadjudicated'].includes(c.adjudication.status), 'adjudication status');
    if (c.adjudication.status === 'confirmed') signature({ reviewer: c.adjudication.reviewer, judgementRef: c.adjudication.judgementRef });
    else check(c.adjudication.reviewer === undefined && c.adjudication.judgementRef === undefined, 'unsigned hypothesis');
    check(Array.isArray(c.expectations) && c.expectations.length <= 10000 && (c.adjudication.status !== 'confirmed' || c.expectations.length > 0), 'expectations');
    const expected = new Set();
    for (const e of c.expectations) {
      keys(e, ['id', 'kind', 'evidenceRefs'], 'expectation');
      check(text(e.id) && !expected.has(e.id) && ['positive', 'negative', 'harmful'].includes(e.kind), 'unique expectation/kind');
      expected.add(e.id); strings(e.evidenceRefs, 'expectation evidence references');
    }
    check(c.causeCluster === undefined || text(c.causeCluster), 'cause cluster');
    check(c.lifecycleOutcome === undefined || ['fix', 'wrong', 'intentional', 'not-worth'].includes(c.lifecycleOutcome), 'lifecycle outcome');
  }
  return manifest;
}

// Exact injected JSON report binding; property order is deliberately part of this digest.
export function incidentReportDigest(report) {
  return createHash('sha256').update(JSON.stringify(report)).digest('hex');
}

/** Validate actual full report arrays, not a page or a model-shaped verdict object.
 * Identity is the caller's captured preview identity and must agree with every report
 * identity field present. Human judgements, not model verification, decide quality.
 */
export function validateIncidentReport(report, expected) {
  identity(expected);
  check(object(report) && REPORT_STATES.includes(report.status), 'report status');
  check(report.snapshotId === expected.snapshotId, 'report snapshot identity mismatch');
  for (const [key, actual] of Object.entries({ provider: report.model?.provider, model: report.model?.model, runtimeVersion: report.runtime?.version, baseRevision: report.history?.base, targetRevision: report.history?.target })) {
    if (actual !== undefined) check(actual === expected[key], 'report ' + key + ' identity mismatch');
  }
  check(Array.isArray(report.files) && Array.isArray(report.findings) && report.files.length <= 100000 && report.findings.length <= 100000, 'full report arrays');
  for (const [key, length] of [['totalFiles', report.files.length], ['totalFindings', report.findings.length]]) {
    if (report[key] !== undefined) check(count(report[key]) && report[key] === length, 'report pagination totals');
  }
  const fileIds = new Set();
  for (const f of report.files) {
    check(object(f) && text(f.fileId) && !fileIds.has(f.fileId) && text(f.path) && FILE_STATES.includes(f.status), 'report file');
    fileIds.add(f.fileId);
  }
  for (const f of report.findings) check(object(f) && text(f.fileId) && fileIds.has(f.fileId) && text(f.title), 'report finding');
  if (report.coverage !== undefined) {
    check(object(report.coverage) && Object.values(report.coverage).every(count), 'coverage counts');
    for (const state of FILE_STATES) if (report.coverage[state] !== undefined) check(report.coverage[state] === report.files.filter(f => f.status === state).length, 'coverage inconsistent with files');
    if (report.coverage.total !== undefined) check(report.coverage.total === report.files.length, 'coverage total');
  }
  if (report.modelCalls !== undefined) check(count(report.modelCalls), 'model calls');
  if (report.diagnostics?.modelCalls !== undefined) check(count(report.diagnostics.modelCalls) && (report.modelCalls === undefined || report.diagnostics.modelCalls === report.modelCalls), 'diagnostic calls');
  if (report.outdated !== undefined) check(typeof report.outdated === 'boolean', 'outdated flag');
  if (report.stageContinuation !== undefined) {
    check(object(report.stageContinuation), 'stage continuation');
    for (const state of ['pending', 'running', 'stopped']) if (report.stageContinuation[state] !== undefined) check(count(report.stageContinuation[state]), 'stage count');
  }
  if (report.interactions !== undefined) check(Array.isArray(report.interactions) && report.interactions.every(item => object(item) && FILE_STATES.includes(item.status)), 'interactions');
  return { complete: reportSummaryData(report).complete && report.outdated !== true, findings: report.findings.length };
}

/** Runs are pre-registered in the manifest: omissions remain incomplete observations.
 * No matcher, model verifier or retry selector can promote a hypothesis into gold.
 * Recall/clean rates use all planned runs; unresolved or missing observations make
 * these observed rates, not proof of absence. Precision uses only judged findings.
 * Reviewer/ref fields attest supplied adjudication, not cryptographic authentication.
 * All findings count as emitted candidates (including refuted candidates); consumers
 * evaluating a narrower displayed surface must supply that surface explicitly.
 */
export function evaluateIncidentRuns(manifest, runs) {
  validateIncidentManifest(manifest);
  check(Array.isArray(runs) && runs.length <= 10000, 'runs');
  const cases = new Map(manifest.cases.map(c => [c.id, c])), observed = new Map();
  for (const run of runs) {
    keys(run, ['caseId', 'runId', 'identity', 'jobStatus', 'report', 'judgements', 'elapsedMs'], 'run');
    const c = cases.get(run.caseId), key = JSON.stringify([run.caseId, run.runId]);
    check(c && c.runIds.includes(run.runId) && !observed.has(key), 'unplanned/duplicate run');
    identity(run.identity); check(isDeepStrictEqual(run.identity, c.identity), 'run identity mismatch');
    check(['completed', 'failed', 'cancelled', 'interrupted'].includes(run.jobStatus), 'job status');
    if (run.elapsedMs !== undefined) check(Number.isFinite(run.elapsedMs) && run.elapsedMs >= 0, 'elapsed time');
    if (run.report !== undefined && run.report !== null) validateIncidentReport(run.report, c.identity);
    check(run.judgements === undefined || Array.isArray(run.judgements), 'finding judgements');
    const seen = new Set(), matched = new Set();
    const reportSha256 = run.report ? incidentReportDigest(run.report) : null;
    for (const j of run.judgements ?? []) {
      keys(j, ['findingIndex', 'reportSha256', 'outcome', 'expectationId', 'reviewer', 'judgementRef', 'evidenceRefs'], 'finding judgement');
      signature({ reviewer: j.reviewer, judgementRef: j.judgementRef }); strings(j.evidenceRefs, 'finding evidence references');
      check(run.report && count(j.findingIndex) && j.findingIndex < run.report.findings.length && !seen.has(j.findingIndex), 'finding index');
      seen.add(j.findingIndex);
      check(j.reportSha256 === reportSha256, 'judgement report digest');
      check(['truePositive', 'falsePositive', 'harmful', 'unresolved'].includes(j.outcome), 'finding outcome');
      const e = c.expectations.find(e => e.id === j.expectationId);
      if (j.expectationId !== undefined) check(e, 'unknown expectation');
      if (j.outcome === 'truePositive') {
        check(e?.kind === 'positive' && !matched.has(e.id), 'unique positive match'); matched.add(e.id);
      }
      if (j.outcome === 'harmful' && e) check(e.kind === 'harmful', 'harmful expectation');
      if (j.outcome === 'falsePositive' && e) check(e.kind === 'negative', 'negative expectation');
    }
    observed.set(key, run);
  }
  const quality = { truePositive: 0, falsePositive: 0, harmful: 0, unresolved: 0, expectedPositives: 0, confirmedRuns: 0, unadjudicatedRuns: 0, cleanRuns: 0, cleanRunsWithFindings: 0, cleanRunsWithFalsePositive: 0, cleanRunsWithHarmful: 0, cleanRunsResolved: 0 };
  const operations = { plannedRuns: 0, suppliedRuns: runs.length, missingRuns: 0, completeRuns: 0, incompleteRuns: 0, calls: 0, callsKnownRuns: 0, elapsedMs: 0, elapsedKnownRuns: 0 };
  const results = [];
  for (const c of manifest.cases) for (const runId of c.runIds) {
    const run = observed.get(JSON.stringify([c.id, runId])), report = run?.report;
    const complete = !!report && run.jobStatus === 'completed' && validateIncidentReport(report, c.identity).complete;
    operations.plannedRuns++; operations[complete ? 'completeRuns' : 'incompleteRuns']++;
    if (!run) operations.missingRuns++;
    const calls = report?.modelCalls ?? report?.diagnostics?.modelCalls;
    if (calls !== undefined) { operations.calls += calls; operations.callsKnownRuns++; }
    if (run?.elapsedMs !== undefined) { operations.elapsedMs += run.elapsedMs; operations.elapsedKnownRuns++; }
    const gold = c.adjudication.status === 'confirmed', positives = c.expectations.filter(e => e.kind === 'positive').length;
    quality[gold ? 'confirmedRuns' : 'unadjudicatedRuns']++;
    const row = { caseId: c.id, runId, gold, complete, findingCount: report?.findings.length ?? null, truePositive: 0, falsePositive: 0, harmful: 0, unresolved: 0 };
    if (gold) {
      quality.expectedPositives += positives;
      const judges = new Map((run?.judgements ?? []).map(j => [j.findingIndex, j]));
      for (let i = 0; i < (report?.findings.length ?? 0); i++) row[judges.get(i)?.outcome ?? 'unresolved']++;
      for (const k of ['truePositive', 'falsePositive', 'harmful', 'unresolved']) quality[k] += row[k];
      if (!positives) {
        quality.cleanRuns++;
        if (row.findingCount > 0) quality.cleanRunsWithFindings++;
        if (row.falsePositive || row.harmful) quality.cleanRunsWithFalsePositive++;
        if (row.harmful) quality.cleanRunsWithHarmful++;
        if (complete && !row.unresolved) quality.cleanRunsResolved++;
      }
    }
    results.push(row);
  }
  const knownFindings = quality.truePositive + quality.falsePositive + quality.harmful;
  return { version: 1, scope: 'expert-adjudicated-emitted-candidates-all-planned-runs', operations, quality: { ...quality,
    precisionDenominator: knownFindings, precision: knownFindings ? quality.truePositive / knownFindings : null,
    recallDenominator: quality.expectedPositives, recall: quality.expectedPositives ? quality.truePositive / quality.expectedPositives : null,
    cleanFalsePositiveRate: quality.cleanRuns ? quality.cleanRunsWithFalsePositive / quality.cleanRuns : null,
    cleanHarmfulRate: quality.cleanRuns ? quality.cleanRunsWithHarmful / quality.cleanRuns : null,
  }, runs: results };
}
