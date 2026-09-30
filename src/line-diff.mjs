import { changeRegion } from './change-region.mjs';

export function lineDiff(before, after, { maxCells = 200000, ...options } = {}) {
  if (!Number.isSafeInteger(maxCells) || maxCells < 1 || maxCells > 2000000) throw new RangeError('Invalid cell limit');
  const region = changeRegion(before, after, options);
  if (region.status !== 'changed') return { ...region, edits: [] };
  const split = text => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const a = split(before), b = split(after);
  const offset = region.old.start - 1, n = region.old.count, m = region.new.count;
  if ((n + 1) * (m + 1) > maxCells) return { status: 'limited', reason: 'Diff cell limit exceeded', envelope: region, edits: [] };
  const width = m + 1, table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    table[i * width + j] = a[offset + i] === b[offset + j] ? 1 + table[(i + 1) * width + j + 1] : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  }
  const edits = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[offset + i] === b[offset + j]) { i++; j++; continue; }
    const startI = i, startJ = j;
    while (i < n || j < m) {
      if (i < n && j < m && a[offset + i] === b[offset + j]) break;
      if (i < n && (j === m || table[(i + 1) * width + j] >= table[i * width + j + 1])) i++;
      else j++;
    }
    edits.push({ old: { start: offset + startI + 1, count: i - startI }, new: { start: offset + startJ + 1, count: j - startJ }, removed: a.slice(offset + startI, offset + i).join(''), added: b.slice(offset + startJ, offset + j).join('') });
  }
  return { status: 'changed', precision: 'exact', edits };
}
