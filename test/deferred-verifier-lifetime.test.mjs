import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { reviewSnapshot } from '../src/review.mjs';

const options = {
  enableRetrieval: true, enableVerification: true, enableStageContinuation: true,
  readerBudgetPolicy: 'fixed', changesConcurrency: 1, maxRetrievalRounds: 10,
  maxInputBytes: 11000, timeoutMs: 5000,
};

function snapshot() {
  const before = Array.from({ length: 100 }, (_, i) => 'line' + i + 'x'.repeat(200));
  const after = [...before]; after[10] = 'changed10'; after[80] = 'changed80';
  return { id: 'deferred-verifier-lifetime', vcs: 'git', context: [], files: [
    { id: 'wide', path: 'wide.js', eligibility: 'reviewable', properties: [], left: { text: before.join('\n') }, right: { text: after.join('\n') } },
    ...[1, 2].map(i => ({ id: 'peer' + i, path: 'peer' + i + '.js', eligibility: 'reviewable', properties: [], left: { text: 'safe();\n' }, right: { text: 'unsafe();\n' } })),
  ] };
}

function finding(title, start, editIds) {
  return { fileId: 'wide', severity: 'high', title, evidence: 'Changed operations violate the guard',
    trigger: 'Invalid input', impact: 'Operation fails', suggestion: 'Restore the guard',
    anchor: { kind: 'line', side: 'new', start, end: start, snippet: start === 11 ? 'changed10' : 'changed80' },
    attribution: { editIds, properties: [], beforeBehavior: 'guarded', afterBehavior: 'unguarded', reason: 'Changed operations' } };
}

async function run(review = reviewSnapshot) {
  const primary = new Map(), starts = [], verified = [], events = [], synthesisReceipts = [];
  let query = 0, synthesisCalls = 0;
  const report = await review(snapshot(), async request => {
    const p = JSON.parse(request.input);
    if (request.reviewPhase === 'verification') {
      const candidate = p.candidates[0].finding;
      const seed = p.retrieved.find(item => item.result.receiptId)?.result;
      assert.ok(seed, 'each independent verifier must receive fresh host-prefetched evidence');
      if (request.callPurpose === 'primary-initial') {
        starts.push({ title: candidate.title, receipt: seed.receiptId });
        events.push('verify:' + candidate.title);
      }
      // Real approved reader calls exhaust the early unit's fair share; peers have
      // not released their floors yet. No synthetic exception or allocator mock.
      if (starts.length === 1) return { requests: Array.from({ length: 8 }, (_, i) => ({ kind: 'find', query: 'absent-' + (++query) + '-' + i, limit: 1 })) };
      verified.push({ title: candidate.title, receipt: seed.receiptId });
      return { verdicts: [{ candidateId: 'c1', verdict: 'supported', reason: 'Fresh independent source evidence', evidence: [{ receiptId: seed.receiptId }] }] };
    }
    if (request.reviewPhase === 'window-synthesis') {
      synthesisCalls++;
      events.push('synthesis');
      if (!p.retrieved.length) return { requests: [
        { kind: 'read', id: 's2', start: 11, count: 1 },
        { kind: 'read', id: 's2', start: 81, count: 1 },
      ] };
      assert.deepEqual(p.retrieved.map(item => item.result.text), ['changed10\n', 'changed80\n']);
      synthesisReceipts.push(...p.retrieved.map(item => item.result.receiptId));
      return { findings: [finding('Combined edits candidate', 81, ['e1', 'e2'])], limitations: [] };
    }
    const id = p.file.id;
    primary.set(id, (primary.get(id) ?? 0) + 1);
    events.push('primary:' + id);
    if (id !== 'wide') return { findings: [], limitations: [] };
    assert.equal(p.windows.length, 1);
    // Only the first window emits a candidate. The later synthesis has a distinct
    // title AND anchor so report grouping cannot hide a missing second verifier.
    return { findings: p.windows[0].editIds.includes('e1') ? [finding('Primary window candidate', 11, ['e1'])] : [], limitations: [] };
  }, options);
  return { report, primary, starts, verified, events, synthesisCalls, synthesisReceipts };
}

function assertComplete(result) {
  const { report, primary, starts, verified, events, synthesisCalls, synthesisReceipts } = result;
  assert.deepEqual([...primary], [['wide', 2], ['peer1', 1], ['peer2', 1]], 'accepted primary generations must never replay');
  assert.equal(starts.length, 3, 'yielded primary, fresh primary retry, and independent synthesis verifier');
  assert.deepEqual(starts.map(row => row.title), ['Primary window candidate', 'Primary window candidate', 'Combined edits candidate']);
  assert.equal(new Set(starts.map(row => row.receipt)).size, 3);
  assert.ok(starts.every(row => !synthesisReceipts.includes(row.receipt)), 'generation receipts are not verifier receipts');
  assert.deepEqual(verified.map(row => row.title), ['Primary window candidate', 'Combined edits candidate']);
  assert.ok(events.indexOf('primary:peer2') < events.lastIndexOf('verify:Primary window candidate'), 'retry waits for peer floors to release');
  assert.equal(synthesisCalls, 2, 'synthesis actually reads both new-side edits');
  assert.equal(report.findings.length, 2);
  assert.ok(report.findings.every(row => row.verification.status === 'completed' && row.verification.verdict === 'supported'));
  assert.deepEqual(report.findings.map(row => row.anchor.start).sort((a, b) => a - b), [11, 81]);
  assert.equal(report.stageContinuation.pending, 0);
  assert.ok(report.continuation.units.some(unit => unit.kind === 'verification' && unit.status === 'completed'));
  assert.ok(report.continuation.units.some(unit => unit.kind === 'synthesis' && unit.status === 'completed'));
  assert.doesNotMatch(JSON.stringify(report), /Reader allocation unit unavailable|READER_UNIT_UNAVAILABLE/);
  assert.ok(report.files.every(row => !row.stageFailures?.length && !row.continuationPending));
  assert.ok(report.readerBudget.calls <= report.readerBudget.maxCalls);
}

test('deferred primary verifier keeps allocation alive for queued same-file synthesis verifier', async () => {
  assertComplete(await run());
});

// Load only a one-condition mutant in memory. Relative dependencies still resolve
// to the real modules; neither production source nor another test is modified.
async function withoutQueuedLifetimeGuard() {
  const url = new URL('../src/review.mjs', import.meta.url);
  const source = await readFile(url, 'utf8');
  const guard = ' && !queuedStageUnits.has(stage.allocationId)) readerAllocation?.release(stage.allocationId);';
  assert.equal(source.split(guard).length, 2, 'mutation must remove exactly the direct drain release guard');
  const mutated = source.replace(guard, ') readerAllocation?.release(stage.allocationId);')
    .replace(/from '([.][/][^']+)'/g, (_, path) => 'from ' + JSON.stringify(new URL(path, url).href));
  return (await import('data:text/javascript;base64,' + Buffer.from(mutated).toString('base64'))).reviewSnapshot;
}

test('the same real fixture detects removing only the queued verification allocation lifetime guard', async () => {
  const result = await run(await withoutQueuedLifetimeGuard());
  assert.throws(() => assertComplete(result), assert.AssertionError);
  assert.equal(result.report.findings.length, 2, 'both accepted candidates survive even in the broken version');
  assert.equal(result.verified.length, 1, 'the prematurely released allocation prevents synthesis verification');
  assert.ok(result.report.limitations.some(row => row.text.includes('Reader allocation unit unavailable')));
  assert.equal(result.report.findings.find(row => row.title === 'Combined edits candidate').verification.status, 'incomplete');
});
