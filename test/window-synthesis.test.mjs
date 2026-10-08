import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareWindowSynthesis as prepare } from '../src/window-synthesis.mjs';
const batch = id => JSON.stringify({ snapshotId: 's', file: { id: 'f' }, context: [{ text: 'KEEP_CONTEXT' }], rules: [{ text: 'KEEP_RULE' }], sourceMode: 'change-windows', windows: [{ id, editIds: ['e' + id], old: { start: 20, count: 3, text: 'SOURCE_OLD' }, new: { start: 30, count: 4, text: 'SOURCE_NEW' } }] });
const measure = payload => ({ bytes: Buffer.byteLength(payload), fits: Buffer.byteLength(payload) < 10000 });
test('synthesis carries complete original window catalog without copying or pretending source evidence', () => {
 const plan = prepare([batch('1'), batch('2')], measure); const p = JSON.parse(plan.payload);
 assert.equal(p.sourceMode, 'window-synthesis'); assert.equal(p.windows, undefined);
 assert.deepEqual(plan.windowIds, ['1', '2']); assert.equal(p.windowIndex[1].new.start, 30);
 assert.ok(plan.payload.includes('KEEP_CONTEXT')); assert.ok(plan.payload.includes('KEEP_RULE'));
 assert.ok(!plan.payload.includes('SOURCE_OLD')); assert.equal(plan.windows[0].old.text, 'SOURCE_OLD');
});
test('duplicate or mixed snapshots reject and measured overflow stays explicit', () => {
 assert.throws(() => prepare([batch('1'), batch('1')], measure));
 assert.throws(() => prepare([batch('1'), batch('2').replace('snapshotId":"s', 'snapshotId":"other')], measure));
 assert.equal(prepare([batch('1'), batch('2')], () => ({ fits: false, bytes: 99999 })).budget.fits, false);
});
