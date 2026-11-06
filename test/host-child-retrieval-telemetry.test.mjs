import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostReviewChildren, REVIEW_CHILD_PRESET } from '../src/host-review-children.mjs';
import { getReviewChildBinding, executeReviewChildRequests } from '../src/review-child-broker.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
const route = { provider: 'mock', model: 'never-network' };
const snapshot = { id: 's', context: [], files: [{ id: 'f', path: 'a.js', eligibility: 'reviewable', left: { text: 'old();' }, right: { text: 'new();' } }] };
const valid = { requests: [{ kind: 'read', id: 's2', start: 1, count: 1 }] };
// All host activation objects are explicit mocks; no real provider or SDK calls.
async function runScenario(run, { maxRounds = 3, readerOptions } = {}) {
  const controller = new AbortController(), parent = { id: 'parent', session: { header: { id: 'parent' } } };
  const events = [], unobserved = [], scope = createRetrievalScope(snapshot, readerOptions);
  let started = 0;
  const runtime = { getProvider: () => ({ capabilities: { outputSchema: true, agentPreset: true, agentOptions: true } }), resolveMaxDepth: () => 1,
    async startActivation(spec) {
      started++;
      const agent = { id: spec.childId, session: { header: { id: spec.childId, parentSession: 'parent', agentPreset: REVIEW_CHILD_PRESET } } };
      return { result: Promise.resolve().then(() => { getReviewChildBinding(spec.childId).beforeModelCall({ ...route, system: '', messages: [], tools: [] }); return run({ read: args => executeReviewChildRequests(args, { agent }), controller, scope, observe: extra => getReviewChildBinding(spec.childId).beforeModelCall({ ...route, system: '', messages: [], tools: [], ...extra }) }); }), dispose: async () => {} };
    } };
  const ctx = { get: name => ({ subagents: runtime, agentPresets: { register: async () => async () => {} }, agents: { get() {} } }[name]) };
  const host = createHostReviewChildren(ctx), child = await host.create({ parent, route, cwd: '/repo', signal: controller.signal });
  try {
    assert.deepEqual(child.retrievalTelemetry, { version: 1, complete: true, scope: 'schema-authorization-range' });
    assert.ok(Object.isFrozen(child.retrievalTelemetry));
    await child.runPrimary({ request: { input: JSON.stringify({ snapshotId: 's', sourceMode: 'group-primary', reviews: [] }), instructions: 'review' }, scope, maxRounds, maxInputBytes: 98304, reserveModelCall: () => {}, onRetrievalProtocolError: event => events.push(event), onRetrievalProtocolUnobserved: event => unobserved.push(event) });
  } finally { await child.dispose(); await host.dispose(); }
  return { events, unobserved, started, usage: scope.usage() };
}
const terminal = () => ({ stopReason: 'completed', structured: { reviews: [], limitations: [] } });

test('schema source and range invalid tool invocations each emit one fixed source-free event', async () => {
  const result = await runScenario(({ read }) => {
    for (const args of [
      { requests: [{ kind: 'unsupported-SECRET' }] },
      { requests: [{ kind: 'read', id: 'SECRET', start: 1, count: 1 }] },
      { requests: [{ kind: 'search', query: 'SECRET', limit: 1, sourceIds: ['SECRET'] }] },
      { requests: [{ kind: 'read', id: 's2', start: 100, count: 1 }] },
      { requests: [{ kind: 'read', id: 's2', start: 0, count: 1 }] },
    ]) assert.throws(() => read(args));
    return terminal();
  });
  assert.deepEqual(result.events.map(e => e.category), ['invalid-schema', 'unauthorized-source', 'unauthorized-source', 'invalid-range', 'invalid-schema']);
  assert.ok(result.events.every(e => e.code === 'RETRIEVAL_PROTOCOL_ERROR'));
  assert.ok(!JSON.stringify(result.events).includes('SECRET'));
  assert.equal(result.started, 1); assert.equal(result.usage.calls, 0);
});

test('invalid requests caught by runtime and repeated invocations are counted separately, not twice per call', async () => {
  const result = await runScenario(({ read }) => {
    const bad = { requests: [{ kind: 'read', id: 's2', start: 2, count: 1 }] };
    assert.throws(() => read(bad)); assert.throws(() => read(bad));
    assert.ok(read(valid).results.length); return terminal();
  });
  assert.equal(result.events.length, 2); assert.equal(result.usage.calls, 1);
});

test('reader and round budgets are not invalid protocol events', async () => {
  const result = await runScenario(({ read }) => { read(valid); assert.throws(() => read(valid), /budget/); return terminal(); }, { readerOptions: { maxCalls: 1 } });
  assert.deepEqual(result.events, []);
  const zero = await runScenario(({ read }) => { assert.throws(() => read(valid), /rounds exhausted/); return terminal(); }, { maxRounds: 0 });
  assert.deepEqual(zero.events, []);
});



test('round exhaustion reports unobserved authorization and range validation once per schema-valid denial', async () => {
  const result = await runScenario(({ read }) => {
    for (const args of [{ requests: [{ kind: 'read', id: 'FOREIGN', start: 1, count: 1 }] }, { requests: [{ kind: 'read', id: 's2', start: 999, count: 1 }] }]) assert.throws(() => read(args), /rounds exhausted/);
    assert.throws(() => read({ requests: [] }), /Invalid retrieval batch/);
    return terminal();
  }, { maxRounds: 0 });
  assert.deepEqual(result.unobserved, [{ code: 'RETRIEVAL_VALIDATION_NOT_OBSERVED' }, { code: 'RETRIEVAL_VALIDATION_NOT_OBSERVED' }]);
  assert.equal(result.events.length, 1); assert.equal(result.events[0].category, 'invalid-schema');
  assert.equal(result.usage.calls, 0);
});

test('capacity final-only early return reports unobserved without classifying blocked requests invalid', async () => {
  const result = await runScenario(({ read, observe }) => {
    observe({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(82000) }] }] });
    assert.equal(read(valid).deliveryStatus, 'not-delivered-capacity-policy');
    for (const args of [{ requests: [{ kind: 'read', id: 'FOREIGN', start: 1, count: 1 }] }, { requests: [{ kind: 'read', id: 's2', start: 999, count: 1 }] }]) assert.equal(read(args).deliveryStatus, 'not-delivered-capacity-policy');
    assert.throws(() => read({ requests: [] }), /Invalid retrieval batch/);
    return terminal();
  });
  assert.equal(result.unobserved.length, 2);
  assert.ok(result.unobserved.every(e => e.code === 'RETRIEVAL_VALIDATION_NOT_OBSERVED'));
  assert.equal(result.events.length, 1); assert.equal(result.usage.calls, 0);
});

test('cancellation refuses tool execution without emitting invalid telemetry after abort', async () => {
  let count = 0;
  await assert.rejects(runScenario(({ read, controller }) => { controller.abort(new Error('cancelled')); assert.throws(() => read({ requests: [] }), /cancelled/); count++; return terminal(); }), /cancelled/);
  assert.equal(count, 1);
});
