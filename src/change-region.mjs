// A conservative envelope, not a minimal edit script.
export function changeRegion(before, after, { maxBytes = 4 * 1024 * 1024 } = {}) {
  if (typeof before !== 'string' || typeof after !== 'string') throw new TypeError('Expected text');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('Invalid diff limit');
  if (Buffer.byteLength(before) + Buffer.byteLength(after) > maxBytes) return { status: 'limited', reason: 'Diff byte limit exceeded' };
  // Keep terminators: newline-only edits must not disappear.
  const split = text => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const left = split(before), right = split(after);
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
  if (prefix === left.length && prefix === right.length) return { status: 'unchanged' };
  let endLeft = left.length, endRight = right.length;
  while (endLeft > prefix && endRight > prefix && left[endLeft - 1] === right[endRight - 1]) { endLeft--; endRight--; }
  return { status: 'changed', precision: 'envelope', old: { start: prefix + 1, count: endLeft - prefix }, new: { start: prefix + 1, count: endRight - prefix } };
}
