import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHunks } from '../src/hunks.mjs';
test('context windows merge overlapping and touching edits', () => {
  const a = 'a\nb\nc\nd\ne\nf\ng\n', b = 'a\nx\nc\nd\ne\ny\ng\n';
  assert.equal(buildHunks(a, b, { contextLines: 1 }).hunks.length, 2);
  const merged = buildHunks(a, b, { contextLines: 2 }).hunks;
  assert.equal(merged.length, 1);
  assert.equal(merged[0].old.text, a);
  assert.equal(merged[0].new.text, b);
  assert.equal(merged[0].edits.length, 2);
});
test('insertion deletion and EOF context stay inside both sources', () => {
  for (const [a, b] of [['', 'x'], ['x', ''], ['a\n', 'a\nx\n'], ['a', 'a\n'], ['a\nb\nc\n', 'a\nc\n']]) {
    const result = buildHunks(a, b);
    assert.equal(result.hunks.length, 1);
    assert.equal(result.hunks[0].old.text, a);
    assert.equal(result.hunks[0].new.text, b);
  }
});
test('zero context exposes only edits and preserves shifted coordinates', () => {
  const h = buildHunks('a\nb\nc\n', 'x\na\nb\ny\n', { contextLines: 0 }).hunks;
  assert.equal(h.length, 2);
  assert.deepEqual(h[0].old, { start: 1, count: 0, text: '' });
  assert.deepEqual(h[1].new, { start: 4, count: 1, text: 'y\n' });
});
test('generated hunk ranges partition edits and reconstruct their target slices', () => {
  let seed = 719;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.floor(seed / 4294967296 * n); };
  const split = s => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const text = () => Array.from({ length: random(30) }, () => ['a\n', 'b\r\n', '\n', '字\n'][random(4)]).join('') + (random(2) ? 'tail' : '');
  for (let k = 0; k < 500; k++) {
    const a = text(), b = text(), contextLines = random(6);
    const result = buildHunks(a, b, { contextLines });
    assert.notEqual(result.status, 'limited');
    assert.deepEqual(result.hunks.flatMap(h => h.edits), result.edits);
    let previous;
    for (const h of result.hunks) {
      for (const [side, source] of [['old', a], ['new', b]]) {
        const range = h[side], sourceLines = split(source);
        assert.ok(range.start >= 1 && range.start - 1 + range.count <= sourceLines.length);
        assert.equal(range.text, sourceLines.slice(range.start - 1, range.start - 1 + range.count).join(''));
        if (previous) assert.ok(previous[side].start + previous[side].count < range.start);
      }
      const reconstructed = split(h.old.text);
      for (const e of [...h.edits].reverse()) {
        assert.ok(e.old.start >= h.old.start && e.old.start + e.old.count <= h.old.start + h.old.count);
        assert.ok(e.new.start >= h.new.start && e.new.start + e.new.count <= h.new.start + h.new.count);
        reconstructed.splice(e.old.start - h.old.start, e.old.count, e.added);
      }
      assert.equal(reconstructed.join(''), h.new.text);
      previous = h;
    }
  }
});

test('large changed inputs stop at the cell budget', () => {
  const result = buildHunks('a\n'.repeat(10000), 'b\n'.repeat(10000));
  assert.equal(result.status, 'limited');
  assert.deepEqual(result.hunks, []);
  assert.equal(result.envelope.old.count, 10000);
});

test('unchanged and limited inputs do not invent hunks', () => {
  assert.deepEqual(buildHunks('a', 'a').hunks, []);
  assert.equal(buildHunks('a', 'b', { maxCells: 1 }).status, 'limited');
  assert.deepEqual(buildHunks('a', 'b', { maxBytes: 1 }).hunks, []);
  assert.throws(() => buildHunks('', '', { contextLines: -1 }), /context/);
});
