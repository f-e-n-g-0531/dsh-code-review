import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerReviewChild, getBinding, assertReviewChildAgent, attachReviewChildMiddleware } from '../src/review-child-broker.mjs';
import { apply, registerSnapshotTool, SNAPSHOT_TOOL_SCHEMA } from '../src/review-child-plugin.mjs';
import { parseRetrievalResponse } from '../src/retrieval-protocol.mjs';

// All contexts/agents below are explicit mocks, not proof of real host behavior.
function fixture(t, overrides = {}) {
  const id = randomUUID(), events = [], agents = new Map(), hooks = new Map();
  const agent = { id, session: { header: { id, parentSession: 'parent', agentPreset: 'restricted' } } };
  agents.set(id, agent);
  const binding = { parentId: 'parent', presetId: 'restricted',
    assertAgent(value) { assert.equal(value, agent); },
    executeRequests(args) { events.push('read'); return { requests: args.requests }; },
    beforeModelCall(options) { events.push('reserve'); if (options.model !== 'approved') throw new Error('route changed'); },
    ...overrides,
  };
  const revoke = registerReviewChild(id, binding); t.after(revoke);
  const ctx = { get: name => name === 'agents' ? agents : undefined,
    on(event, handler) { hooks.set(event, handler); return () => hooks.delete(event); } };
  attachReviewChildMiddleware(ctx);
  const options = { sessionId: id, model: 'approved', tools: [{ name: 'review_snapshot' }, { name: 'structured_output' }] };
  const stream = (value = options) => hooks.get('llm/stream').call({ mock: 'LlmRuntime' }, value, () => { events.push('next'); return 'stream'; });
  return { id, agent, binding, revoke, ctx, hooks, options, stream, events, agents };
}
function plugin() {
  const definitions = [], restrictions = [], hooks = new Map();
  // Explicit root-global registration mock, followed by a distinct preset scope.
  // This does not emulate or prove the host's inheritance/composition machinery.
  registerSnapshotTool({ tools: { register: value => definitions.push(value) } });
  apply({ tools: { register: () => assert.fail('preset must not register a scoped tool'), restrict: value => restrictions.push(value) }, on: (event, handler) => hooks.set(event, handler) });
  return { tool: definitions[0], definitions, restrictions, hooks };
}



test('snapshot schema exposes exact discoverable read/find/search fields in the finite host subset', () => {
  const { tool } = plugin(), schema = tool.parameters;
  assert.equal(tool.parameters, SNAPSHOT_TOOL_SCHEMA.parameters);
  assert.equal(tool.description, SNAPSHOT_TOOL_SCHEMA.description);
  assert.equal(tool.name, SNAPSHOT_TOOL_SCHEMA.name);
  const variants = schema.properties.requests.items.oneOf;
  assert.deepEqual(schema.required, ['requests']);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(variants.map(v => v.properties.kind.const), ['read', 'find', 'search']);
  const fields = [['kind', 'id', 'start', 'count'], ['kind', 'query', 'limit'], ['kind', 'query', 'limit', 'sourceIds']];
  for (const [index, variant] of variants.entries()) {
    assert.equal(variant.type, 'object');
    assert.equal(variant.additionalProperties, false);
    assert.deepEqual(Object.keys(variant.properties), fields[index]);
    assert.deepEqual(variant.required, index === 2 ? ['kind', 'query', 'limit'] : fields[index]);
    assert.equal(variant.properties.kind.type, 'string');
  }
  assert.equal(variants[0].properties.start.type, 'integer');
  assert.equal(variants[0].properties.count.type, 'integer');
  assert.equal(variants[2].properties.sourceIds.items.type, 'string');
  // Reject constraints unsupported by the host's finite JSON-schema converter.
  const supported = new Set(['type', 'description', 'properties', 'additionalProperties', 'required', 'items', 'oneOf', 'const']);
  const visit = node => {
    for (const [key, value] of Object.entries(node)) {
      assert.ok(supported.has(key), 'unsupported schema keyword: ' + key);
      if (key === 'properties') Object.values(value).forEach(visit);
      if (key === 'items') visit(value);
      if (key === 'oneOf') value.forEach(visit);
    }
  };
  visit(schema);
  assert.ok(tool.description.includes('1..8'));
  assert.ok(tool.description.includes('NOT regex'));
});

test('public description examples parse unchanged and aliases or out-of-range reads remain rejected', async t => {
  const { tool } = plugin();
  const examples = [...tool.description.matchAll(/\{"requests":\[.*?\}\]\}/g)].map(match => JSON.parse(match[0]));
  assert.equal(examples.length, 3);
  assert.deepEqual(examples.map(value => parseRetrievalResponse(value)[0].kind), ['read', 'find', 'search']);
  let executed = 0;
  const f = fixture(t, { executeRequests(args) { const requests = parseRetrievalResponse(args); executed++; return { requests }; } });
  for (const args of examples) assert.deepEqual(JSON.parse((await tool.execute(args, { agent: f.agent })).json).requests, args.requests);
  assert.equal(executed, 3);
  for (const count of [0, 201, 1.5]) await assert.rejects(tool.execute({ requests: [{ kind: 'read', id: 'catalog-id', start: 1, count }] }, { agent: f.agent }), /Invalid read request/);
  for (const request of [{ operation: 'read', id: 'catalog-id', start: 1, count: 1 }, { kind: 'grep', query: 'x', limit: 10 }, { kind: 'read', path: 'a.js', start: 1, count: 1 }]) assert.throws(() => parseRetrievalResponse({ requests: [request] }), /Unsupported retrieval operation|Invalid read request/);
  assert.throws(() => parseRetrievalResponse({ requests: Array.from({ length: 9 }, () => examples[0].requests[0]) }), /Invalid retrieval batch/);
  assert.equal(executed, 3, 'parser rejection must precede business execution');
});

test('mock: reservation is exact and revoked IDs cannot be reused', t => {
  const f = fixture(t);
  assert.equal(getBinding(f.id), f.binding);
  assert.throws(() => registerReviewChild(f.id, f.binding), /reserved/);
  assert.equal(getBinding(randomUUID()), undefined);
  f.revoke(); f.revoke();
  assert.throws(() => getBinding(f.id), /revoked/);
  assert.throws(() => registerReviewChild(f.id, f.binding), /revoked/);
  assert.throws(() => f.stream(), /revoked/);
  assert.deepEqual(f.events, []);
});

test('mock: agent/session header, parent and preset identity fail closed', t => {
  const f = fixture(t);
  assert.equal(assertReviewChildAgent(f.id, f.agent), f.binding);
  for (const field of ['id', 'parentSession', 'agentPreset']) {
    const original = f.agent.session.header[field];
    f.agent.session.header[field] = 'wrong';
    assert.throws(() => f.stream(), /does not match/);
    f.agent.session.header[field] = original;
  }
  f.agent.id = 'wrong';
  assert.throws(() => f.stream(), /does not match/);
  f.agent.id = f.id;
  f.agents.delete(f.id);
  assert.throws(() => f.stream(), /does not match/);
  assert.deepEqual(f.events, []);
});

test('mock: guard reserves synchronously before stream and route failure never dispatches', t => {
  const f = fixture(t);
  assert.equal(f.stream(), 'stream');
  assert.deepEqual(f.events, ['reserve', 'next']);
  assert.throws(() => f.stream({ ...f.options, model: 'other' }), /route changed/);
  assert.deepEqual(f.events, ['reserve', 'next', 'reserve']);
  assert.equal(f.stream({ sessionId: randomUUID() }), 'stream');
});

test('mock: only approved tools plus required host structured_output can dispatch', t => {
  const f = fixture(t);
  for (const tools of [undefined, [], [{ name: 'review_snapshot' }], [{ name: 'structured_output' }, { name: 'pwsh' }], [{ name: 'structured_output' }, { name: 'structured_output' }], [null]]) {
    assert.throws(() => f.stream({ ...f.options, tools }), /tools changed/);
  }
  assert.deepEqual(f.events, []);
  assert.equal(f.stream({ ...f.options, tools: [{ name: 'structured_output' }] }), 'stream');
});

test('mock: identity and tool failures synchronously poison the owner before retry', t => {
  for (const kind of ['identity', 'tools']) {
    let fatal, fatalCalls = 0, reservations = 0;
    const f = fixture(t, {
      onFatal(error) { fatal ??= error; fatalCalls++; },
      beforeModelCall() { if (fatal) throw fatal; reservations++; },
    });
    if (kind === 'identity') f.agent.session.header.parentSession = 'wrong';
    const invalid = kind === 'tools' ? { ...f.options, tools: [{ name: 'pwsh' }] } : f.options;
    let first;
    assert.throws(() => f.stream(invalid), error => { first = error; return true; });
    assert.equal(fatal, first);
    assert.equal(fatalCalls, 1);
    assert.equal(reservations, 0);
    f.agent.session.header.parentSession = 'parent';
    assert.throws(() => f.stream(), error => error === first);
    assert.equal(fatalCalls, 2);
    assert.equal(reservations, 0);
    assert.deepEqual(f.events, []);
  }
});

test('mock: asynchronous model guard is rejected without dispatch', t => {
  const f = fixture(t, { beforeModelCall: () => Promise.resolve() });
  assert.throws(() => f.stream(), /must be synchronous/);
  assert.deepEqual(f.events, []);
});

test('mock: middleware registration is idempotent on the root context', t => {
  const f = fixture(t), handler = f.hooks.get('llm/stream');
  attachReviewChildMiddleware(f.ctx);
  assert.equal(f.hooks.get('llm/stream'), handler);
});

test('mock: root registers snapshot once and shared preset allows that global tool before any step', async t => {
  const f = fixture(t), p = plugin();
  assert.equal(p.definitions.length, 1);
  assert.equal(p.tool.name, 'review_snapshot');
  assert.deepEqual(p.restrictions, [{ allow: ['review_snapshot'] }]);
  assert.equal(p.hooks.get('agent/pre-step')({ agent: f.agent }, () => 'step'), 'step');
  assert.throws(() => p.hooks.get('agent/pre-step')({ agent: { ...f.agent, id: randomUUID() } }, () => 'step'), /does not match/);
  assert.equal(p.tool.parameters.properties.requests.items.oneOf.length, 3);
  const result = await p.tool.execute({ requests: [{ kind: 'catalog' }] }, { agent: f.agent });
  assert.deepEqual(JSON.parse(result.json), { requests: [{ kind: 'catalog' }] });
  assert.deepEqual(p.tool.output.render({}, result), [{ type: 'text', text: result.json }]);
  assert.deepEqual(p.tool.output.schema.required, ['json']);
  await assert.rejects(p.tool.execute({ requests: [] }, { agent: { ...f.agent, id: randomUUID() } }), /does not match/);
  f.revoke();
  await assert.rejects(p.tool.execute({ requests: [] }, { agent: f.agent }), /revoked/);
});

test('mock: root parent and unbound sibling snapshot calls cannot charge reader usage', async t => {
  let executions = 0;
  // Usage here is an explicit binding-owned mock, not real reader instrumentation.
  const readerUsage = { calls: 3, outputBytes: 128 };
  const f = fixture(t, { executeRequests() { executions++; readerUsage.calls++; readerUsage.outputBytes += 64; return {}; } });
  const { tool } = plugin();
  const parent = { id: 'parent', session: { header: { id: 'parent', agentPreset: 'root' } } };
  const siblingId = randomUUID();
  const sibling = { id: siblingId, session: { header: { id: siblingId, parentSession: 'parent', agentPreset: 'restricted' } } };
  for (const agent of [parent, sibling]) {
    const before = { ...readerUsage };
    await assert.rejects(tool.execute({ requests: [{ kind: 'catalog' }] }, { agent }), /does not match/);
    assert.equal(executions, 0);
    assert.deepEqual(readerUsage, before);
  }
  await tool.execute({ requests: [] }, { agent: f.agent });
  assert.equal(executions, 1);
  assert.deepEqual(readerUsage, { calls: 4, outputBytes: 192 });
});

test('mock: shared preset dispatches separate children without captured binding', async t => {
  const a = fixture(t), b = fixture(t), { tool } = plugin();
  await tool.execute({ requests: [] }, { agent: a.agent });
  await tool.execute({ requests: [] }, { agent: b.agent });
  assert.deepEqual(a.events, ['read']);
  assert.deepEqual(b.events, ['read']);
});

test('mock: revocation while a snapshot operation is pending suppresses output', async t => {
  let release;
  const f = fixture(t, { executeRequests: () => new Promise(resolve => { release = resolve; }) });
  const { tool } = plugin();
  const pending = tool.execute({ requests: [] }, { agent: f.agent });
  f.revoke(); release({ secret: 'not returned' });
  await assert.rejects(pending, /revoked/);
});
