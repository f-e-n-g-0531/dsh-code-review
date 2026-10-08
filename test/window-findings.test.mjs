import test from 'node:test';
import assert from 'node:assert/strict';
import { validateWindowFindings } from '../src/window-findings.mjs';
const windows = [{ editIds: ['e1'], old: { start: 10, count: 3 }, new: { start: 10, count: 4 } }];
const finding = () => ({ attribution: { status: 'references-validated', editIds: ['e1'] }, anchor: { kind: 'line', side: 'new', start: 11, end: 13 } });
test('batch accepts original anchor and its assigned edit only', () => {
  assert.doesNotThrow(() => validateWindowFindings([finding()], windows));
  assert.doesNotThrow(() => validateWindowFindings([], windows));
});
test('other-batch edits missing attribution and out-of-window anchors fail closed', () => {
  for (const patch of [{ attribution: { status: 'missing' } }, { attribution: { status: 'references-validated', editIds: ['e2'] } }, { anchor: { kind: 'line', side: 'new', start: 14, end: 14 } }]) assert.throws(() => validateWindowFindings([{ ...finding(), ...patch }], windows), /outside current/);
});
