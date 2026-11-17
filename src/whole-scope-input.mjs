import { createHash } from 'node:crypto';
import { changeWindows } from './change-windows.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const lines = text => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

// Transport-only projection. Never pass this file to the catalog or validator.
// No textual search: duplicate lines and CRLF retain their exact original offsets.
export function focusedWholeReview(row, { catalog = [], project = false } = {}) {
  const { file, changes } = row;
  const windows = !project && changes.precision === 'exact' ? changeWindows(file, changes) : null;
  if (!windows) return { ...row, primarySource: { mode: 'full', fallback: project ? 'project-current-source' : 'no-exact-hunk-windows', completeText: true } };
  const source = side => {
    const original = side === 'old' ? file.left : file.right;
    const parts = lines(original.text), offsets = [0];
    for (const part of parts) offsets.push(offsets.at(-1) + part.length);
    const entry = catalog.find(item => item.fileId === row.fileId && item.side === side);
    return { original, parts, offsets, entry, textHash: hash(original.text) };
  };
  const sources = { old: source('old'), new: source('new') };
  const sourceWindows = windows.map(window => ({ id: window.id, editIds: window.editIds, ...Object.fromEntries(['old', 'new'].map(side => {
    const range = window[side], src = sources[side];
    const startOffset = src.offsets[range.start - 1], endOffset = src.offsets[range.start - 1 + range.count];
    if (!Number.isSafeInteger(startOffset) || !Number.isSafeInteger(endOffset) || src.original.text.slice(startOffset, endOffset) !== range.text) throw new Error('Invalid focused source offsets');
    return [side, { ...range, snapshotId: row.snapshotId, fileId: row.fileId, side,
      ...(src.entry ? { sourceId: src.entry.id } : {}),
      ...(src.original.hash !== undefined ? { hash: src.original.hash } : {}), textHash: src.textHash,
      startOffset, endOffset, offsetUnit: 'utf16-code-unit', endExclusive: true }];
  })) }));
  const strip = ({ text, ...identity }, side) => ({ ...identity, side, textHash: sources[side].textHash, lineCount: sources[side].parts.length, textProvided: false });
  return { ...row, file: { ...file, left: strip(file.left, 'old'), right: strip(file.right, 'new') }, sourceWindows,
    primarySource: { mode: 'focused', completeText: false, completeEdits: true, coordinateSystem: 'original-source',
      notice: 'Exact diff hunks with context only, not full files or complete function/semantic coverage. Missing necessary implementation/contracts must be read on demand from the unchanged approved catalog; unavailable evidence remains a limitation. Anchors use original side and line coordinates.' } };
}
