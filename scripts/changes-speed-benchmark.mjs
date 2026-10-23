// Offline actual review entrypoint comparison; never sends source to a provider.
// Usage: node scripts/changes-speed-benchmark.mjs [baseline-directory]
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { reviewSnapshot } from '../src/review.mjs';
const latencyMs = 20;
const input = { id: 'mock-svn', vcs: 'svn', context: [], history: { vcs: 'svn', baseRevision: '7363', targetRevision: '7364' }, files: Array.from({ length: 8 }, (_, i) => ({ id: 'f' + i, path: i + '.txt', eligibility: 'reviewable', properties: [], left: { text: 'guard();\r\n' }, right: { text: 'unsafe();\r\n' } })) };
async function measure(execute, concurrency) {
  let calls = 0, active = 0, peak = 0;
  const started = performance.now();
  const report = await execute(input, async request => {
    calls++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, latencyMs)); active--;
    const p = JSON.parse(request.input);
    if (!p.file && !p.candidates) return { groups: input.files.map(file => ({ fileIds: [file.id], reason: 'Independent controlled fixture' })) };
    if (p.candidates) {
      if (!p.retrieved.length) return { requests: [{ kind: 'read', id: p.catalog.find(s => s.fileId === p.candidates[0].finding.fileId && s.side === 'new').id, start: 1, count: 1 }] };
      return { verdicts: [{ candidateId: 'c1', verdict: 'refuted', reason: 'Controlled evidence validation fixture only', evidence: [{ receiptId: p.retrieved[0].result.receiptId }] }] };
    }
    return { findings: [{ fileId: p.file.id, severity: 'high', title: 'candidate', evidence: 'untrusted hypothesis', trigger: 'input', impact: 'failure', suggestion: 'guard', anchor: { kind: 'line', side: 'new', start: 1, end: 1, snippet: 'unsafe();' } }], limitations: [] };
  }, { changesConcurrency: concurrency, enableRetrieval: true, enableVerification: true, enableGrouping: true, enableBusinessGrouping: true, enableRiskPlanning: true, skipSmallRiskPlans: true, enableAnchorCorrection: true, correctProtocol: true });
  assert.equal(report.files.length, input.files.length);
  assert.ok(report.files.every(f => f.status === 'completed'));
  assert.ok(report.findings.every(f => f.verification.status === 'completed' && f.verification.verdict === 'refuted'));
  return { elapsedMs: Math.round(performance.now() - started), calls, peakInFlight: peak, completed: report.coverage.completed, finalValidationRetained: true, findings: report.findings.map(f => ({ fileId: f.fileId, verdict: f.verification.verdict, evidence: f.verification.evidence.map(({ snapshotId, sourceId, hash, start, count, text }) => ({ snapshotId, sourceId, hash, start, count, text })) })) };
}
let baseline;
if (process.argv[2]) baseline = await measure((await import(pathToFileURL(path.resolve(process.argv[2], 'src/review.mjs')).href)).reviewSnapshot, 1);
const patchedSerial = await measure(reviewSnapshot, 1), patchedParallel = await measure(reviewSnapshot, 2);
assert.deepEqual(patchedSerial.findings, patchedParallel.findings);
if (baseline) assert.deepEqual(baseline.findings, patchedSerial.findings);
const brief = run => run && Object.fromEntries(Object.entries(run).filter(([key]) => key !== 'findings'));
console.log(JSON.stringify({ mock: true, network: false, productionChangesFlags: true, latencyMs, files: input.files.length, baseline: brief(baseline), patchedSerial: brief(patchedSerial), patchedParallel: brief(patchedParallel), notice: 'Controlled candidate/refutation fixture through real review entrypoints; no real-provider latency or review-quality equivalence claimed.' }, null, 2));
