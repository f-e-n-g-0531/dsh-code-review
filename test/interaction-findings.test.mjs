import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInteractionFindings as validate } from '../src/interaction-findings.mjs';
const file = id => ({ id, path: id+'.js', eligibility: 'reviewable', properties: [], left: { text: 'old' }, right: { text: 'new' } });
const snapshot = { id: 'snap', files: [file('a'), file('b'), file('outside')] }, group = { fileIds: ['a', 'b'] };
const catalog = [{ id: 's1', fileId: 'a', side: 'new' }, { id: 's2', fileId: 'b', side: 'new' }];
const reads = catalog.map(s => ({ kind: 'read', snapshotId: 'snap', sourceId: s.id, start: 1, count: 1 }));
const raw = { fileId: 'a', severity: 'high', title: 'contract', evidence: 'two edits', trigger: 'missing value', impact: 'failure', suggestion: 'align', anchor: { kind: 'line', side: 'new', start: 1, end: 1, snippet: 'new' }, attribution: { editIds: ['e1'], properties: [], beforeBehavior: 'safe', afterBehavior: 'broken', reason: 'interaction' }, interaction: { editRefs: [{ fileId: 'a', editId: 'e1' }, { fileId: 'b', editId: 'e1' }] } };
const check = (candidate = raw, audit = reads) => validate({ findings: [candidate], limitations: [] }, snapshot, group, audit, catalog);
test('same edit IDs across files retain qualified references original anchor and unverified causality', () => {
 const before = structuredClone(raw); const finding = check().findings[0];
 assert.equal(finding.interaction.causality, 'unverified'); assert.deepEqual(finding.interaction.editRefs, raw.interaction.editRefs); assert.deepEqual(finding.anchor, raw.anchor); assert.deepEqual(raw, before);
});
test('foreign duplicate single-file forged edits missing reads and anchor reject', () => {
 for (const refs of [[{ fileId:'a',editId:'e1' },{ fileId:'outside',editId:'e1' }],[{ fileId:'a',editId:'e1' },{ fileId:'a',editId:'e1' }],[{ fileId:'a',editId:'e1' },{ fileId:'b',editId:'e9' }]]) assert.throws(() => check({ ...raw, interaction: { editRefs: refs } }));
 assert.throws(() => check(raw, reads.slice(0,1)), /not read/);
 assert.throws(() => check(raw, reads.map(r => ({ ...r, snapshotId:'foreign' }))), /not read/);
 assert.throws(() => check({ ...raw, anchor:{ ...raw.anchor, snippet:'forged' } }), /snippet/);
});
