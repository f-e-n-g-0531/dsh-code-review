import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAttribution } from '../src/attribution.mjs';
const file = { left: { text: 'old\n' }, right: { text: 'new\n' }, properties: [{ name: 'p', old: null, new: 'yes' }] };
const value = () => ({ editIds: ['e1'], properties: [], beforeBehavior: 'old behavior', afterBehavior: 'new behavior', reason: 'claimed regression' });
test('valid references do not certify causal correctness', () => {
  const result = validateAttribution(value(), file);
  assert.equal(result.status, 'references-validated');
  assert.equal(result.causality, 'unverified');
  assert.deepEqual(validateAttribution(undefined, file), { status: 'missing', causality: 'unverified' });
  assert.equal(validateAttribution({ ...value(), editIds: [], properties: ['p'] }, file).status, 'references-validated');
});
test('invented empty duplicate and unchanged references are rejected', () => {
  for (const patch of [{ editIds: ['e9'] }, { editIds: [] }, { editIds: ['e1', 'e1'] }, { properties: ['unknown'] }, { reason: '' }, { properties: null }]) assert.throws(() => validateAttribution({ ...value(), ...patch }, file));
  assert.throws(() => validateAttribution(value(), { ...file, right: file.left }), /Unknown/);
});
