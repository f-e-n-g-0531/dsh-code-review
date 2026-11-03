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

test('bounded frontier recovers distant edits with shifted CRLF and EOF coordinates', () => {
  const a = Array.from({ length: 10000 }, (_, i) => 'line ' + i + '\r\n');
  const b = [...a];
  b.splice(9999, 1, 'late replacement');
  b.splice(10, 0, 'inserted\r\n');
  const before = a.join(''), after = b.join(''), result = lineDiff(before, after);
  assert.equal(result.precision, 'exact');
  assert.equal(result.edits.length, 2);
  assert.deepEqual(result.edits[0].old, { start: 11, count: 0 });
  assert.deepEqual(result.edits[1].new, { start: 10001, count: 1 });
  for (const edit of [...result.edits].reverse()) a.splice(edit.old.start - 1, edit.old.count, edit.added);
  assert.equal(a.join(''), after);
  assert.deepEqual(lineDiff(before, after), result);
});

test('frontier fallback agrees with independent LCS cost on repeated-line mutations', () => {
  let seed = 43;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.floor(seed / 4294967296 * n); };
  for (let run = 0; run < 200; run++) {
    const a = Array.from({ length: 60 }, () => ['a\n', 'b\r\n', '\n', 'Tail\n'][random(4)]), b = [...a];
    b[0] = 'early\n'; b[b.length - 1] = 'late';
    for (let i = 0; i < 4; i++) b.splice(random(b.length), random(3), ...Array.from({ length: random(3) }, () => 'new\n'));
    const oracle = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) oracle[i][j] = a[i - 1] === b[j - 1] ? oracle[i - 1][j - 1] + 1 : Math.max(oracle[i - 1][j], oracle[i][j - 1]);
    const result = lineDiff(a.join(''), b.join(''), { maxCells: 3000 });
    assert.equal(result.precision, 'exact');
    assert.equal(result.edits.reduce((n, e) => n + e.old.count + e.new.count, 0), a.length + b.length - 2 * oracle[a.length][b.length]);
    const forward = [...a], reverse = [...b];
    for (const e of [...result.edits].reverse()) {
      assert.equal(a.slice(e.old.start - 1, e.old.start - 1 + e.old.count).join(''), e.removed);
      assert.equal(b.slice(e.new.start - 1, e.new.start - 1 + e.new.count).join(''), e.added);
      forward.splice(e.old.start - 1, e.old.count, e.added);
      reverse.splice(e.new.start - 1, e.new.count, e.removed);
    }
    assert.equal(forward.join(''), b.join(''));
    assert.equal(reverse.join(''), a.join(''));
  }
});

test('sparse snakes still obey equality-probe and byte budgets without partial edits', () => {
  const middle = 'same\n'.repeat(2000), before = 'a\n' + middle + 'b\n', after = 'x\n' + middle + 'y\n';
  for (const options of [{ maxCells: 100 }, { maxBytes: 100 }]) {
    const result = lineDiff(before, after, options);
    assert.equal(result.status, 'limited');
    assert.deepEqual(result.edits, []);
    assert.equal(result.precision, undefined);
  }
});

test('cell exhaustion never masquerades as exact diff', () => {
  const result = lineDiff('a\nb\n', 'x\ny\n', { maxCells: 4 });
  assert.equal(result.status, 'limited'); assert.deepEqual(result.edits, []);
  assert.equal(result.envelope.precision, 'envelope');
});
