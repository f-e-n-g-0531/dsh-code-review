import { lineDiff } from './line-diff.mjs';

// Coordinates are one-based; zero-count ranges denote insertion boundaries.
export function buildHunks(before, after, { contextLines = 3, ...options } = {}) {
  if (!Number.isSafeInteger(contextLines) || contextLines < 0 || contextLines > 100) throw new RangeError('Invalid context limit');
  const diff = lineDiff(before, after, options);
  if (diff.status !== 'changed') return { ...diff, hunks: [] };
  const split = text => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const left = split(before), right = split(after);
  const groups = [];
  for (const edit of diff.edits) {
    const oldStart = edit.old.start - 1, newStart = edit.new.start - 1;
    const leading = Math.min(contextLines, oldStart, newStart);
    const trailing = Math.min(contextLines, left.length - oldStart - edit.old.count, right.length - newStart - edit.new.count);
    const range = { oldStart: oldStart - leading, newStart: newStart - leading, oldEnd: oldStart + edit.old.count + trailing, newEnd: newStart + edit.new.count + trailing, edits: [edit] };
    const last = groups.at(-1);
    if (last && range.oldStart <= last.oldEnd && range.newStart <= last.newEnd) {
      last.oldEnd = Math.max(last.oldEnd, range.oldEnd);
      last.newEnd = Math.max(last.newEnd, range.newEnd);
      last.edits.push(edit);
    } else groups.push(range);
  }
  const hunks = groups.map((g, i) => ({
    id: 'h' + (i + 1),
    old: { start: g.oldStart + 1, count: g.oldEnd - g.oldStart, text: left.slice(g.oldStart, g.oldEnd).join('') },
    new: { start: g.newStart + 1, count: g.newEnd - g.newStart, text: right.slice(g.newStart, g.newEnd).join('') },
    edits: g.edits,
  }));
  return { ...diff, hunks };
}
