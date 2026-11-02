import { changeMap } from './change-map.mjs';
import { changeRegion } from './change-region.mjs';

// Canonical review transport coordinates, recomputed solely from approved source.
// An envelope is a bounded broad region, never an exact edit or causal proof.
export function reviewChangeMap(before, after) {
  const changes = changeMap(before, after);
  if (changes.status !== 'limited') return changes;
  const region = changeRegion(before, after);
  if (region.status !== 'changed') return changes;
  return {
    status: 'changed', precision: 'envelope',
    reason: 'Exact diff unavailable; broad region includes potentially unchanged lines, not exact edits or causal proof.',
    edits: [{ id: 'envelope1', old: region.old, new: region.new }],
    hunks: [{ id: 'envelope-h1', old: region.old, new: region.new, editIds: ['envelope1'] }],
  };
}
