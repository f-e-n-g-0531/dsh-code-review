// Pure projection of exact change-map ranges; never rebases source line numbers.
export function changeWindows(file, changes) {
  if (changes.status !== 'changed' || !changes.hunks.length || changes.hunks.length > 200) return null;
  const split = text => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const before = split(file.left.text), after = split(file.right.text);
  const project = (range, lines) => {
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.count) || range.start < 1 || range.count < 0 || range.start - 1 + range.count > lines.length) throw new Error('Invalid window range');
    return { ...range, text: lines.slice(range.start - 1, range.start - 1 + range.count).join('') };
  };
  return changes.hunks.map(h => ({ id: h.id, editIds: [...h.editIds], old: project(h.old, before), new: project(h.new, after) }));
}
