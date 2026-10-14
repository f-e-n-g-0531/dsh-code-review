import { relativePath } from './content.mjs';

// Candidate reconstruction only: a diff does not establish old-node identity or
// old properties. Capture must verify those separately before approving a source.
export function replacementTextCandidate(diff, name, workingText, { maxBytes = 256 * 1024 } = {}) {
  relativePath(name);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) throw new Error('Invalid replacement byte limit');
  if (typeof diff !== 'string' || typeof workingText !== 'string' || Buffer.byteLength(diff) > 2 * maxBytes + 16 * 1024 || Buffer.byteLength(workingText) > maxBytes) throw new Error('Replacement diff input limit exceeded');
  if (!diff.endsWith('\n')) throw new Error('Replacement diff record is truncated');
  const lines = diff.split('\n');
  const header = index => lines[index]?.replace(/\r$/, '');
  if (header(0) !== 'Index: ' + name || !/^=+$/.test(header(1) ?? '')) throw new Error('Unexpected replacement diff scope');
  const oldHeader = header(2), newHeader = header(3);
  const prefix = '--- ' + name + '\t(revision ';
  if (!oldHeader?.startsWith(prefix) || !/^[0-9]+\)$/.test(oldHeader.slice(prefix.length)) || newHeader !== '+++ ' + name + '\t(working copy)') throw new Error('Replacement diff requires target revision and working side');
  const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/.exec(header(4) ?? '');
  if (!hunk) throw new Error('Replacement diff requires one full hunk');
  const oldStart = Number(hunk[1]), oldCount = Number(hunk[2] ?? 1), newStart = Number(hunk[3]), newCount = Number(hunk[4] ?? 1);
  if (![oldStart,oldCount,newStart,newCount].every(Number.isSafeInteger) || oldStart !== (oldCount ? 1 : 0) || newStart !== (newCount ? 1 : 0) || oldCount > maxBytes || newCount > maxBytes) throw new Error('Replacement hunk does not start at both file boundaries');
  const oldLines = [], newLines = [];
  let previous, oldNoEol = false, newNoEol = false;
  for (let i = 5; i < lines.length; i++) {
    const line = lines[i];
    if (i === lines.length - 1 && line === '') break;
    if (header(i) === '\\ No newline at end of file') {
      if (!previous) throw new Error('Detached replacement EOF marker');
      if (previous !== '+') {
        if (oldNoEol) throw new Error('Duplicate old EOF marker');
        oldNoEol = true;
      }
      if (previous !== '-') {
        if (newNoEol) throw new Error('Duplicate new EOF marker');
        newNoEol = true;
      }
      previous = undefined;
      continue;
    }
    const marker = line[0];
    if (![' ', '-', '+'].includes(marker)) throw new Error('Unexpected replacement diff record');
    if (marker !== '+') {
      if (oldNoEol) throw new Error('Old text follows EOF marker');
      oldLines.push(line.slice(1));
    }
    if (marker !== '-') {
      if (newNoEol) throw new Error('New text follows EOF marker');
      newLines.push(line.slice(1));
    }
    previous = marker;
    if (oldLines.length > oldCount || newLines.length > newCount) throw new Error('Replacement hunk count exceeded');
  }
  if (oldLines.length !== oldCount || newLines.length !== newCount) throw new Error('Replacement hunk truncated');
  const text = (items, noEol) => items.join('\n') + (items.length && !noEol ? '\n' : '');
  const oldText = text(oldLines, oldNoEol), newText = text(newLines, newNoEol);
  if (Buffer.byteLength(oldText) > maxBytes || Buffer.byteLength(newText) > maxBytes) throw new Error('Replacement text limit exceeded');
  if (newText !== workingText) throw new Error('Replacement diff does not match complete working text');
  return { oldText, newText, oldRevision: oldHeader.slice(prefix.length, -1), status: 'candidate-only', notice: 'Not approved old-node identity, bytes, encoding or properties; capture still requires independent provenance verification.' };
}
