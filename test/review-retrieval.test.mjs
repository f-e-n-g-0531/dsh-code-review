import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewSnapshot } from '../src/review.mjs';
const snapshot = () => ({ id: 's', vcs: 'git', files: [{ id: 'f', path: 'a', eligibility: 'reviewable', left: { text: 'old' }, right: { text: 'new' }, properties: [] }], context: [{ path: 'helper', text: 'definition' }] });
const read = { requests: [{ kind: 'read', id: 's3', start: 1, count: 1 }] };
test('review integrates retrieval and accounts for every model call', async () => {
  let calls = 0;
  const result = await reviewSnapshot(snapshot(), async request => {
    calls++;
    if (calls === 1) return read;
    assert.equal(JSON.parse(request.input).retrieved[0].result.text, 'definition');
    return { findings: [], limitations: [] };
  }, { enableRetrieval: true });
  assert.equal(result.status, 'completed'); assert.equal(result.modelCalls, 2);
  assert.equal(result.retrievalUsage.calls, 1);
  const audit = result.files[0].retrievalAudit[0];
  assert.equal(audit.sourceId, 's3');
  assert.equal(audit.stage, 'retrieved-locally');
  assert.match(audit.hash, /^[0-9a-f]{64}$/);
  assert.equal(audit.text, undefined);
  assert.equal(result.retrievalSources.find(s => s.id === audit.sourceId).path, 'helper');
});
test('global call limit stops retrieval follow-up and preserves failure state', async () => {
  const result = await reviewSnapshot(snapshot(), async () => read, { enableRetrieval: true, maxCalls: 1 });
  assert.equal(result.modelCalls, 1); assert.equal(result.status, 'failed');
  assert.match(result.files[0].reason, /call budget/);
  assert.equal(result.files[0].retrievalAudit[0].stage, 'retrieved-locally');
});
test('one timeout spans the entire retrieval loop and awaits cancellation', async () => {
  let calls = 0;
  const result = await reviewSnapshot(snapshot(), async ({ signal }) => {
    if (++calls === 1) return read;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, { enableRetrieval: true, timeoutMs: 20 });
  assert.equal(result.status, 'failed'); assert.equal(result.modelCalls, 2);
  assert.match(result.files[0].reason, /timeout/i);
});
