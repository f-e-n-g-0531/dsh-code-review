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
test('limited diffs cannot masquerade as exact windows', () => {
  assert.equal(changeWindows(file('a', 'b'), { status: 'limited', hunks: [] }), null);
});
