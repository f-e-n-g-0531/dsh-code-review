import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCoveragePlan } from '../src/coverage-plan.mjs';
import { preparePrimaryInput } from '../src/primary-input.mjs';
const file = { id: 'a', path: 'a.js', eligibility: 'reviewable', left: { text: 'old' }, right: { text: 'new' }, properties: [] };
const options = { instructions: '只读', maxInputBytes: 10000 };
test('plan shares exact preparation and does not retain source bodies', () => {
  const input = { id: 's', files: [file, { id: 'b', path: 'secret', eligibility: 'excluded' }] };
  const p = buildCoveragePlan(input, options);
  assert.equal(p.items[0].initialInputBytes, preparePrimaryInput(input, file, options).budget.bytes);
  assert.equal(p.minimumCalls, 1);
  assert.equal(p.items[1].status, 'excluded');
  assert.ok(!JSON.stringify(p).includes('old'));
  assert.deepEqual(p, buildCoveragePlan({ ...input, files: [...input.files].reverse() }, options));
  const blocked = buildCoveragePlan(input, { ...options, maxInputBytes: 1 });
  assert.equal(blocked.items[0].status, 'input-blocked'); assert.equal(blocked.minimumCalls, 0);
});
test('plan rejects ambiguous snapshots and honors cancellation', () => {
  assert.throws(() => buildCoveragePlan({ id: 's', files: [file,file] }, options), /Invalid/);
  const c = new AbortController(); c.abort(new Error('cancel plan'));
  assert.throws(() => buildCoveragePlan({ id: 's', files: [file] }, { ...options, signal: c.signal }), /cancel plan/);
});
