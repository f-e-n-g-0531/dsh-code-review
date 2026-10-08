import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareInteractionInput as prepare } from '../src/interaction-input.mjs';
import { interactionCases } from './fixtures/interaction-cases.mjs';
const fixture = interactionCases[0];
const snapshot = { id: 'approved', files: fixture.files.map((f,i) => ({ id: 'f'+i, path: f.path, eligibility: 'reviewable', left: { text: f.old }, right: { text: f.new } })), rules: [{ path: 'rules.md', text: 'keep rules' }], context: [{ path: 'context.js', text: 'keep context' }] };
const group = { id: 'g1', fileIds: ['f0', 'f1'] };
test('interaction navigation retains qualified original edits rules and context without oracle or primary source', () => {
 const before = structuredClone(snapshot);
 const result = prepare(snapshot, group, payload => ({ fits: true, bytes: Buffer.byteLength(payload) }));
 assert.equal(result.status, 'ready'); const p = JSON.parse(result.payload);
 assert.equal(p.files.length, 2); assert.ok(p.files.every(f => f.edits.length && f.edits[0].new.start >= 1));
 assert.equal(p.rules[0].text, 'keep rules'); assert.equal(p.context[0].text, 'keep context');
 assert.ok(!result.payload.includes('export function lookup')); assert.ok(!result.payload.includes('expectation'));
 assert.deepEqual(snapshot, before);
});
test('foreign excluded duplicate oversized groups and input overflow fail closed', () => {
 for (const ids of [['f0', 'foreign'], ['f0', 'f0'], ['f0'], ['f0','f1','f2','f3','f4']]) assert.throws(() => prepare(snapshot, { ...group, fileIds: ids }, () => ({ fits: true })));
 assert.throws(() => prepare({ ...snapshot, files: snapshot.files.map(f => ({ ...f, eligibility: 'excluded' })) }, group, () => ({ fits: true })));
 const result = prepare(snapshot, group, () => ({ fits: false, bytes: 10000 })); assert.equal(result.status, 'blocked'); assert.equal(result.reason, 'input-budget'); assert.equal(JSON.parse(result.payload).rules.length, 1);
});
