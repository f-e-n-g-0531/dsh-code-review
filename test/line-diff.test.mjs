import test from 'node:test';
import assert from 'node:assert/strict';
import { lineDiff } from '../src/line-diff.mjs';
test('separated edits keep independent coordinates', () => {
  const result = lineDiff('a\nb\nc\nd\n', 'x\nb\nc\ny\n');
  assert.equal(result.edits.length, 2);
  assert.equal(result.edits[1].old.start, 4);
  assert.equal(result.edits[1].added, 'y\n');
});
test('deterministic generated inputs reconstruct exact target bytes', () => {
  let seed = 17; const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0);
  const generate = () => Array.from({ length: next() % 16 }, () => ['a\n', 'b\r\n', '\n'][next() % 3]).join('') + (next() % 2 ? 'tail' : '');
  for (let k = 0; k < 300; k++) {
    const before = generate(), after = generate(), result = lineDiff(before, after);
    const lines = before.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    for (const edit of [...result.edits].reverse()) {
      assert.equal(lines.slice(edit.old.start - 1, edit.old.start - 1 + edit.old.count).join(''), edit.removed);
      lines.splice(edit.old.start - 1, edit.old.count, edit.added);
    }
    assert.equal(lines.join(''), after);
    assert.deepEqual(lineDiff(before, after), result);
  }
});
test('exhaustive short sequences have minimal insertion/deletion cost', () => {
  const sequences = [[]];
  for (let length = 1; length <= 4; length++) for (let bits = 0; bits < 2 ** length; bits++) sequences.push(Array.from({ length }, (_, i) => bits & (1 << i) ? 'a\n' : 'b\n'));
  // Independent exhaustive subsequence oracle, not the production LCS recurrence.
  const subsequences = a => new Set(Array.from({ length: 2 ** a.length }, (_, mask) => a.filter((_, i) => mask & (1 << i)).join('')));
  for (const a of sequences) for (const b of sequences) {
    const common = [...subsequences(a)].filter(s => subsequences(b).has(s));
    const longest = Math.max(...common.map(s => s.length / 2));
    const result = lineDiff(a.join(''), b.join(''));
    const cost = result.edits.reduce((sum, e) => sum + e.old.count + e.new.count, 0);
    assert.equal(cost, a.length + b.length - 2 * longest);
    const forward = [...a], reverse = [...b];
    for (const e of [...result.edits].reverse()) {
      forward.splice(e.old.start - 1, e.old.count, e.added);
      reverse.splice(e.new.start - 1, e.new.count, e.removed);
    }
    assert.equal(forward.join(''), b.join(''));
    assert.equal(reverse.join(''), a.join(''));
  }
});

test('empty files and EOF edits use one-based insertion boundaries', () => {
  for (const [before, after] of [['', 'x'], ['x', ''], ['a\n', 'a\nx'], ['a', 'a\n'], ['a\r\n', 'a\n']]) {
    const result = lineDiff(before, after);
    assert.equal(result.status, 'changed');
    assert.equal(result.edits.length, 1);
    assert.ok(result.edits[0].old.start >= 1);
    assert.ok(result.edits[0].new.start >= 1);
  }
  assert.deepEqual(lineDiff('', ''), { status: 'unchanged', edits: [] });
});

test('cell exhaustion never masquerades as exact diff', () => {
  const result = lineDiff('a\nb\n', 'x\ny\n', { maxCells: 4 });
  assert.equal(result.status, 'limited'); assert.deepEqual(result.edits, []);
  assert.equal(result.envelope.precision, 'envelope');
});
