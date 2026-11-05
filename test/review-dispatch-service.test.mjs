import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createReviewService } from '../src/service.mjs';
import { apply } from '../index.mjs';

const execution = () => ({ agent: { session: { header: { cwd: '/repo' } }, options: { provider: 'fixture', model: 'never-network' } }, signal: new AbortController().signal });
function fixture(t, size, options = {}) {
  let directCalls = 0, children = 0, disposed = 0;
  const snapshot = { id: 'dispatch-' + size, root: '/repo', vcs: 'git', context: [], files: [0, 1].map(i => ({ id: 'f' + i, path: i + '.js', eligibility: 'reviewable', properties: [], left: { text: 'old();' }, right: { text: 'x'.repeat(size) } })) };
  const service = createReviewService({ async *stream() { directCalls++; yield { type: 'text-delta', text: JSON.stringify({ findings: [], limitations: [] }) }; yield { type: 'finish', reason: { kind: 'stop' } }; } }, {
    executionStrategy: 'auto', maxInputBytes: 256 * 1024, capture: async (_target, captureOptions) => { assert.equal(captureOptions.executionStrategy, undefined); return structuredClone(snapshot); }, allowModelSending: true, authorize: async () => true,
    hostChildren: { capability: () => true, prepare: async () => {}, create: async () => { children++; return { invoke: request => ({ reviews: JSON.parse(request.input).reviews.map(row => ({ fileId: row.fileId, findings: [], limitations: [] })), limitations: [] }), dispose: async () => { disposed++; } }; } }, ...options,
  });
  t.after(() => service.dispose());
  return { service, exec: execution(), get directCalls() { return directCalls; }, get children() { return children; }, get disposed() { return disposed; } };
}
test('auto fresh small scope previews whole direct without creating children', async t => {
  const f = fixture(t, 10), preview = await f.service.preview({}, f.exec);
  assert.equal(preview.execution.executionStrategy, 'whole-scope'); assert.equal(preview.dispatch.requested, 'auto');
  assert.equal(preview.dispatch.childMode, 'direct'); assert.equal(preview.dispatch.plannedChildCount, 0);
  assert.equal(preview.execution.maxInputBytes, 262144); assert.equal(f.children, 0); assert.equal(f.directCalls, 0);
});
test('auto capacity split executes fixed child factory plan, not direct primary fallback', async t => {
  const f = fixture(t, 130000), preview = await f.service.preview({}, f.exec);
  assert.equal(preview.dispatch.childMode, 'host-subagents'); assert.equal(preview.dispatch.plannedChildCount, 2);
  assert.equal(preview.dispatch.oversizedCount, 0); assert.equal(preview.execution.batchConcurrency, 2);
  const result = await f.service.execute({ previewId: preview.previewId, confirmed: true }, f.exec);
  assert.equal(f.children, 2); assert.equal(f.disposed, 2); assert.equal(f.directCalls, 0);
  assert.equal(result.report.coverage.completed, 2); assert.equal(result.report.coverage.blocked, 0);
  assert.deepEqual(result.report.dispatch, preview.dispatch);
});
test('auto oversized source falls back visibly to staged while preserving both primary files', async t => {
  const f = fixture(t, 300000), preview = await f.service.preview({}, f.exec);
  assert.equal(preview.execution.executionStrategy, 'staged'); assert.equal(preview.dispatch.reason, 'complete-files-exceed-capacity');
  assert.equal(preview.dispatch.oversizedCount, 2); assert.equal(preview.dispatch.eligibleCount, 2);
  assert.equal(preview.dispatch.childMode, 'none'); assert.equal(preview.files.length, 2);
  assert.ok(preview.files.every(file => file.eligibility === 'reviewable')); assert.equal(f.children, 0);
});
test('per-preview explicit staged override preserves user selection and does not reach capture options', async t => {
  const f = fixture(t, 10), preview = await f.service.preview({ executionStrategy: 'staged' }, f.exec);
  assert.equal(preview.execution.executionStrategy, 'staged'); assert.equal(preview.dispatch.reason, 'explicit-staged');
  assert.equal(preview.dispatch.childMode, 'none'); assert.equal(f.children, 0);
});
test('explicit whole multi without host capability fails rather than restoring old serial fallback', async t => {
  const f = fixture(t, 130000, { hostChildren: undefined });
  await assert.rejects(f.service.preview({ executionStrategy: 'whole-scope' }, f.exec), error => error.code === 'REVIEW_SUBAGENTS_UNAVAILABLE');
  assert.equal(f.directCalls, 0); assert.equal(f.children, 0);
});
function plugin(config) {
  const definitions = [], cleanup = [];
  apply({ llm: {}, tools: { register: def => definitions.push(def) }, on: (event, handler) => { if (event === 'dispose') cleanup.push(handler); return () => {}; } }, config);
  return { preview: definitions.find(def => def.name === 'code_review_preview'), dispose: async () => { for (const handler of cleanup) await handler(); } };
}
test('production index default contract is auto/512KiB with nullish overrides, not inferred capacity', async () => {
  // Static wiring assertion only: no real capture/provider or host capability claim.
  const source = await readFile(new URL('../index.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes("executionStrategy: config.executionStrategy ?? 'auto'"));
  assert.ok(source.includes('maxInputBytes: config.maxInputBytes ?? 512 * 1024'));
  const p = plugin({});
  try { assert.deepEqual(p.preview.parameters.properties.executionStrategy.enum, ['auto', 'staged', 'whole-scope']); }
  finally { await p.dispose(); }
});
test('explicit zero configured capacity is not replaced by the production default', async () => {
  const p = plugin({ maxInputBytes: 0 });
  try { await assert.rejects(p.preview.execute({}, execution()), /Invalid configured input capacity/); }
  finally { await p.dispose(); }
});
