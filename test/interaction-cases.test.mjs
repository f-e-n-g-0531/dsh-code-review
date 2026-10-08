import test from 'node:test';
import assert from 'node:assert/strict';
import { interactionCases } from './fixtures/interaction-cases.mjs';
// Executing fixed synthetic functions is a test only, never repository content.
const missingLabel = (value, condition) => condition(value) ? 'missing' : value.name;
test('synthetic cross-file contract fixtures distinguish introduced bug and safe counterexample', () => {
 assert.equal(interactionCases.length, 2);
 assert.equal(missingLabel(null, value => value == null), 'missing');
 assert.throws(() => missingLabel(undefined, value => value === null), TypeError);
 assert.equal(missingLabel(undefined, value => value === undefined), 'missing');
 for (const item of interactionCases) {
  assert.equal(item.files.length, 2);
  assert.ok(item.files.every(file => file.old !== file.new));
  assert.ok(item.files[1].new.includes("import { lookup } from './lookup.js';"));
 }
});
