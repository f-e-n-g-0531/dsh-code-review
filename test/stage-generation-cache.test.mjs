import test from 'node:test';
import assert from 'node:assert/strict';
import { createStageGenerationCache } from '../src/stage-generation-cache.mjs';
import { stageKey } from '../src/review-stage-state.mjs';
const snapshot = { id: 'cache-s', files: [{ id: 'f', path: 'f.js', eligibility: 'reviewable', properties: [], left: { text: 'old();' }, right: { text: 'new();' } }] };
const record = (round = 1, limitations = []) => ({ key: stageKey('f', { phase: 'primary', round }), fileId: 'f', phase: 'primary', round, windowIds: [], generation: { findings: [], limitations } });
test('admission is atomic for malformed records and replacement; later valid records still work', () => {
  const cache = createStageGenerationCache(snapshot);
  assert.equal(cache.admit(record()).accepted, true);
  const before = cache.records();
  assert.deepEqual(cache.admit({ ...record(), key: 'forged' }), { accepted: false, code: 'STAGE_CACHE_RECORD_REJECTED' });
  assert.deepEqual(cache.records(), before);
  assert.equal(cache.admit(record(2)).accepted, true);
  const external = cache.records(); external[0].generation.limitations.push('external mutation');
  assert.equal(cache.records()[0].generation.limitations.length, 0);
  const bad = record(3); Object.defineProperty(bad, 'surprise', { enumerable: true, get() { throw new Error('must not execute'); } });
  assert.equal(cache.admit(bad).accepted, false);
  assert.equal(cache.records().length, 2);
});
test('aggregate byte limit rejects without discarding prior cache or blocking later small records', () => {
  const cache = createStageGenerationCache(snapshot, [], { maxBytes: 1100 });
  assert.ok(cache.admit(record()).accepted);
  assert.equal(cache.admit(record(2, ['x'.repeat(1000)])).code, 'STAGE_CACHE_CAPACITY_EXCEEDED');
  assert.equal(cache.records().length, 1);
  assert.ok(cache.admit(record(3)).accepted);
  assert.deepEqual(cache.records().map(r => r.round), [1, 3]);
  assert.throws(() => createStageGenerationCache(snapshot, [{ ...record(), key: 'forged' }]));
  assert.throws(() => createStageGenerationCache(snapshot, [], { maxBytes: 0 }));
});
test('real 8MiB cumulative storage bound stays intact and failed admission is not exported', () => {
  const cache = createStageGenerationCache(snapshot);
  const limitations = Array.from({ length: 102 }, () => 'x'.repeat(7999));
  for (let round = 1; round <= 10; round++) assert.ok(cache.admit(record(round, limitations)).accepted);
  const before = cache.records();
  assert.equal(cache.admit(record(11, limitations)).code, 'STAGE_CACHE_CAPACITY_EXCEEDED');
  assert.deepEqual(cache.records(), before);
  assert.ok(Buffer.byteLength(JSON.stringify(cache.records())) <= 8 * 1024 * 1024);
  assert.ok(cache.admit(record(12)).accepted);
});
