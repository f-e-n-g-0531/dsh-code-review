import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSynthesisReads as validate } from '../src/synthesis-evidence.mjs';
const changes = { edits: [{ id: 'e1', old: { start: 5, count: 1 }, new: { start: 5, count: 2 } }, { id: 'e2', old: { start: 50, count: 0 }, new: { start: 50, count: 1 } }] };
const findings = [{ attribution: { editIds: ['e1', 'e2'] } }];
const catalog = [{ id: 's1', fileId: 'f', side: 'new' }, { id: 'other', fileId: 'other', side: 'new' }];
const read = (start, count) => ({ kind: 'read', snapshotId: 'snap', sourceId: 's1', start, count });
test('each referenced edit requires complete approved read covering a nonempty source side', () => {
 assert.doesNotThrow(() => validate(findings, changes, [read(5, 2), read(50, 1)], catalog, 'f', 'snap'));
 for (const reads of [[], [read(5, 1), read(50, 1)], [read(5, 2)], [{ ...read(5, 2), kind: 'search' }, read(50, 1)], [{ ...read(5, 2), snapshotId: 'other' }, read(50, 1)], [{ ...read(5, 2), sourceId: 'other' }, read(50, 1)]]) assert.throws(() => validate(findings, changes, reads, catalog, 'f', 'snap'), /not read/);
});
