import { changeRegion } from './change-region.mjs';

// Myers frontier search avoids quadratic rectangles for sparse, distant edits.
// Charge both retained trace cells and equality probes to the same hard budget;
// exhaustion discards the entire script, never promoting a partial alignment.
function boundedMatches(a, b, offset, n, m, budget) {
  const trace = [];
  let used = 0;
  for (let d = 0; d <= n + m; d++) {
    if (used + d + 1 > budget) return null;
    used += d + 1;
    const row = new Int32Array(d + 1), previous = trace.at(-1);
    for (let p = 0; p <= d; p++) {
      const k = 2 * p - d;
      let x = d === 0 ? 0 : p === 0 ? previous[0] : p === d ? previous[p - 1] + 1
        : previous[p - 1] < previous[p] ? previous[p] : previous[p - 1] + 1;
      let y = x - k;
      while (x < n && y < m) {
        if (++used > budget) return null;
        if (a[offset + x] !== b[offset + y]) break;
        x++; y++;
      }
      row[p] = x;
      if (x >= n && y >= m) {
        const matches = [];
        for (let depth = d; depth > 0; depth--) {
          const prev = trace[depth - 1], index = (x - y + depth) / 2;
          const down = index === 0 || (index !== depth && prev[index - 1] < prev[index]);
          const prevX = prev[down ? index : index - 1];
          const prevY = prevX - (x - y + (down ? 1 : -1));
          const count = Math.min(x - prevX, y - prevY);
          if (count > 0) matches.push([x - count, y - count, count]);
          x = prevX; y = prevY;
        }
        if (x > 0) matches.push([0, 0, x]);
        return matches.reverse();
      }
    }
    trace.push(row);
  }
  return null;
}

export function lineDiff(before, after, { maxCells = 200000, ...options } = {}) {
  if (!Number.isSafeInteger(maxCells) || maxCells < 1 || maxCells > 2000000) throw new RangeError('Invalid cell limit');
  const region = changeRegion(before, after, options);
  if (region.status !== 'changed') return { ...region, edits: [] };
  const split = text => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const a = split(before), b = split(after);
  const offset = region.old.start - 1, n = region.old.count, m = region.new.count;
  if ((n + 1) * (m + 1) > maxCells) {
    const matches = boundedMatches(a, b, offset, n, m, maxCells);
    if (!matches) return { status: 'limited', reason: 'Diff cell limit exceeded', envelope: region, edits: [] };
    const edits = [];
    let i = 0, j = 0;
    for (const [nextI, nextJ, count] of [...matches, [n, m, 0]]) {
      if (nextI > i || nextJ > j) edits.push({
        old: { start: offset + i + 1, count: nextI - i },
        new: { start: offset + j + 1, count: nextJ - j },
        removed: a.slice(offset + i, offset + nextI).join(''),
        added: b.slice(offset + j, offset + nextJ).join(''),
      });
      i = nextI + count; j = nextJ + count;
    }
    return { status: 'changed', precision: 'exact', edits };
  }
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
