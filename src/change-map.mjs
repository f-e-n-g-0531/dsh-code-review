import { buildHunks } from './hunks.mjs';

// Source text is already sent once; references avoid repeating it in every hunk.
export function changeMap(before, after, options) {
  const diff = buildHunks(before, after, options);
  if (diff.status !== 'changed') return { status: diff.status, ...(diff.reason ? { reason: diff.reason } : {}), ...(diff.envelope ? { envelope: diff.envelope } : {}), edits: [], hunks: [] };
  const range = ({ start, count }) => ({ start, count });
  const ids = new Map(diff.edits.map((edit, i) => [edit, 'e' + (i + 1)]));
  return { status: diff.status, precision: diff.precision, edits: diff.edits.map(edit => ({ id: ids.get(edit), old: range(edit.old), new: range(edit.new) })), hunks: diff.hunks.map(hunk => ({ id: hunk.id, old: range(hunk.old), new: range(hunk.new), editIds: hunk.edits.map(edit => ids.get(edit)) })) };
}
