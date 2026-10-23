import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewReaderBudget, readerAdmission } from '../src/review-reader-policy.mjs';
import { createSnapshotReader } from '../src/snapshot-reader.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';

const snapshot = n => ({ files: Array.from({ length: n }, () => ({ eligibility: 'reviewable' })) });
const fixed = { maxCalls: 50, maxOutputBytes: 256 * 1024 };
const remaining = { remainingCalls: 2, remainingOutputBytes: 10000 };
const reject = code => ({ permitted: false, code });

test('omitted and explicit fixed policy preserve exact low-level default limits', () => {
  assert.deepEqual(reviewReaderBudget(), fixed);
  assert.deepEqual(reviewReaderBudget(snapshot(74)), fixed);
  assert.deepEqual(reviewReaderBudget(snapshot(1000), 'fixed'), fixed);
  assert.deepEqual(reviewReaderBudget(undefined, 'fixed'), fixed);
  const reader = createSnapshotReader('fixed', [{ id: 's1', text: 'one line' }]);
  assert.equal(reader.budget().maxCalls, fixed.maxCalls);
  assert.equal(reader.budget().maxOutputBytes, fixed.maxOutputBytes);
});

test('scaled policy uses only reviewable count at 0, 1, 74 and hard cap boundaries', () => {
  assert.deepEqual(reviewReaderBudget(snapshot(0), 'scaled'), fixed);
  assert.deepEqual(reviewReaderBudget(snapshot(1), 'scaled'), fixed);
  assert.deepEqual(reviewReaderBudget(snapshot(74), 'scaled'), { maxCalls: 296, maxOutputBytes: 74 * 16 * 1024 });
  assert.deepEqual(reviewReaderBudget(snapshot(250), 'scaled'), { maxCalls: 1000, maxOutputBytes: 250 * 16 * 1024 });
  assert.deepEqual(reviewReaderBudget(snapshot(256), 'scaled'), { maxCalls: 1000, maxOutputBytes: 4 * 1024 * 1024 });
  assert.deepEqual(reviewReaderBudget(snapshot(10000), 'scaled'), { maxCalls: 1000, maxOutputBytes: 4 * 1024 * 1024 });
  const s = snapshot(74);
  s.files.push(...Array.from({ length: 1000 }, (_, i) => ({ eligibility: i % 2 ? 'excluded' : 'blocked' })));
  assert.deepEqual(reviewReaderBudget(s, 'scaled'), { maxCalls: 296, maxOutputBytes: 74 * 16 * 1024 });
});

test('scaled count does not inspect source, path, file size, body or absolute identity', () => {
  const file = { eligibility: 'reviewable' };
  for (const key of ['path', 'left', 'right', 'bytes', 'id']) Object.defineProperty(file, key, { get() { throw new Error('source must not be inspected'); } });
  const input = { files: Array(74).fill(file) };
  assert.deepEqual(reviewReaderBudget(input, 'scaled'), { maxCalls: 296, maxOutputBytes: 1212416 });
  const first = reviewReaderBudget(input, 'scaled'); first.maxCalls = 1;
  assert.equal(reviewReaderBudget(input, 'scaled').maxCalls, 296, 'result objects have no shared mutable policy');
});

test('unknown policy and unavailable or ambiguous eligibility counts fail closed', () => {
  for (const policy of [null, '', 'auto', 'balanced', {}, 74, true]) assert.throws(() => reviewReaderBudget(snapshot(1), policy), /policy/);
  for (const input of [undefined, null, {}, { files: null }, { files: 74 }, { files: [null] }, { files: [{}] }, { files: [{ eligibility: 'pending' }] }, { files: Array(2) }]) {
    assert.throws(() => reviewReaderBudget(input, 'scaled'), /snapshot|file/);
  }
});

test('metadata-only and missing-context stages reject at either shared ledger exhaustion', () => {
  const stages = [{ synthesis: true }, { interaction: true }, { hasRequiredRetrieval: true },
    { metadata: { contextMode: 'approved-retrieval' } }, { contextMode: 'approved-retrieval' },
    { sourceMode: 'window-synthesis' }, { sourceMode: 'file-interaction' },
    { metadata: { sourceMode: 'window-synthesis' } }];
  for (const stage of stages) {
    assert.deepEqual(readerAdmission(stage, remaining), { permitted: true });
    assert.deepEqual(readerAdmission(stage, { ...remaining, remainingCalls: 0 }), reject('READER_CALL_BUDGET_EXCEEDED'));
    assert.deepEqual(readerAdmission(stage, { ...remaining, remainingCalls: -1 }), reject('READER_CALL_BUDGET_EXCEEDED'));
    assert.deepEqual(readerAdmission(stage, { ...remaining, remainingOutputBytes: 0 }), reject('READER_OUTPUT_BUDGET_EXCEEDED'));
    assert.deepEqual(readerAdmission(stage, { ...remaining, remainingOutputBytes: -1 }), reject('READER_OUTPUT_BUDGET_EXCEEDED'));
    assert.deepEqual(readerAdmission(stage, { remainingCalls: 0, remainingOutputBytes: 0 }), reject('READER_CALL_BUDGET_EXCEEDED'));
  }
});

test('full-body and inline-window primaries may continue without reader budget or extra reads', () => {
  for (const stage of [{}, { metadata: {} }, { sourceMode: 'change-windows' }, { metadata: { sourceMode: 'change-windows' } }, { hasRequiredRetrieval: false }]) {
    assert.deepEqual(readerAdmission(stage, { remainingCalls: 0, remainingOutputBytes: 0 }), { permitted: true });
    assert.deepEqual(readerAdmission(stage, undefined), { permitted: true });
  }
  const stage = { metadata: {}, get payload() { throw new Error('must not parse source'); } };
  assert.deepEqual(readerAdmission(stage, undefined), { permitted: true });
  assert.deepEqual(readerAdmission({ synthesis: true, hasRequiredRetrieval: false }, { remainingCalls: 0, remainingOutputBytes: 0 }), reject('READER_CALL_BUDGET_EXCEEDED'));
});

test('required admission rejects unknown counters without optimistic budget refill', () => {
  for (const counters of [undefined, null, {}, { remainingCalls: 1 }, { remainingOutputBytes: 100 },
    { ...remaining, remainingCalls: NaN }, { ...remaining, remainingCalls: Infinity },
    { ...remaining, remainingCalls: '1' }, { ...remaining, remainingOutputBytes: 0.5 }]) {
    assert.deepEqual(readerAdmission({ synthesis: true }, counters), reject('READER_BUDGET_UNAVAILABLE'));
  }
  for (const descriptor of [undefined, null, [], 1, 'fullbody']) {
    assert.deepEqual(readerAdmission(descriptor, remaining), reject('READER_BUDGET_UNAVAILABLE'));
  }
  assert.deepEqual(readerAdmission({ synthesis: true }, { remainingCalls: 1, remainingOutputBytes: 1 }), { permitted: true }, 'positive budget permits attempt but promises no reservation or result fit');
});

test('one explicitly scaled scope stays shared across file stages, admission never charges or resets it', () => {
  const input = { id: 'shared', context: [], files: [
    { id: 'a', path: 'a.js', eligibility: 'reviewable', left: { text: 'old a' }, right: { text: 'new a' } },
    { id: 'b', path: 'b.js', eligibility: 'reviewable', left: { text: 'old b' }, right: { text: 'new b' } },
  ] };
  const limits = reviewReaderBudget(input, 'scaled');
  const scope = createRetrievalScope(input, { ...limits, maxCalls: 2 });
  const catalog = scope.catalog();
  const before = scope.budget();
  assert.deepEqual(readerAdmission({ synthesis: true }, before), { permitted: true });
  assert.deepEqual(scope.budget(), before);
  scope.read({ id: catalog[0].id, start: 1, count: 1 });
  scope.read({ id: catalog[2].id, start: 1, count: 1 });
  assert.equal(scope.budget().remainingCalls, 0);
  assert.deepEqual(readerAdmission({ interaction: true }, scope.budget()), reject('READER_CALL_BUDGET_EXCEEDED'));
  assert.deepEqual(readerAdmission({ metadata: {} }, scope.budget()), { permitted: true });
  assert.throws(() => scope.read({ id: catalog[1].id, start: 1, count: 1 }), /call budget/);
  assert.equal(scope.usage().calls, 2);
});
