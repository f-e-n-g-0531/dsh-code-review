import test from 'node:test';
import assert from 'node:assert/strict';
import { changeWindows } from '../src/change-windows.mjs';
import { changeMap } from '../src/change-map.mjs';
const file = (old, next) => ({ left: { text: old }, right: { text: next } });
test('windows preserve original late line numbers CRLF and EOF text', () => {
  const prefix = Array(100).fill('same' + String.fromCharCode(13, 10)).join('');
  const f = file(prefix + 'before', prefix + 'after');
  const map = changeMap(f.left.text, f.right.text);
  const windows = changeWindows(f, map);
  assert.equal(windows.length, 1);
  assert.ok(windows[0].new.start > 90);
  assert.ok(windows[0].old.text.endsWith('before'));
  assert.ok(windows[0].new.text.endsWith('after'));
  assert.ok(windows[0].new.text.includes(String.fromCharCode(13, 10)));
  assert.deepEqual(windows[0].editIds, ['e1']);
});
test('insert/delete empty sides preserve zero ranges without invented lines', () => {
  for (const f of [file('', 'new'), file('old', '')]) {
    const w = changeWindows(f, changeMap(f.left.text, f.right.text))[0];
    assert.equal(w.old.text, f.left.text); assert.equal(w.new.text, f.right.text);
  }
});
test('large sparse migrations deliver only exact local windows rather than broad envelopes', () => {
  const a = Array.from({ length: 10000 }, (_, i) => 'line ' + i + '\n'), b = [...a];
  b[10] = 'changed early\n'; b[9980] = 'changed late\n';
  const f = file(a.join(''), b.join('')), map = changeMap(f.left.text, f.right.text);
  assert.equal(map.precision, 'exact');
  assert.deepEqual(map.edits.map(e => e.old), [{ start: 11, count: 1 }, { start: 9981, count: 1 }]);
  const windows = changeWindows(f, map);
  assert.equal(windows.length, 2);
  assert.deepEqual(windows.flatMap(w => w.editIds), map.edits.map(e => e.id));
  for (const w of windows) {
    assert.equal(w.old.count, 7); assert.equal(w.new.count, 7);
    assert.equal(w.old.text, a.slice(w.old.start - 1, w.old.start - 1 + w.old.count).join(''));
    assert.equal(w.new.text, b.slice(w.new.start - 1, w.new.start - 1 + w.new.count).join(''));
  }
  const delivered = windows.reduce((n, w) => n + Buffer.byteLength(w.old.text) + Buffer.byteLength(w.new.text), 0);
  assert.ok(delivered < 300, 'must not retransmit the 197269-byte envelope');
});

test('limited diffs cannot masquerade as exact windows', () => {
  assert.equal(changeWindows(file('a', 'b'), { status: 'limited', hunks: [] }), null);
});
