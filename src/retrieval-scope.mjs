import { createSnapshotReader } from './snapshot-reader.mjs';

// Call only after authorization of this exact snapshot; this function grants nothing.
export function createRetrievalScope(snapshot, options) {
  if (!snapshot || !Array.isArray(snapshot.files) || snapshot.files.length > 200 || !Array.isArray(snapshot.context) || snapshot.context.length > 100) throw new Error('Invalid retrieval snapshot');
  const entries = [], catalog = [], paths = new Map(), identities = new Set();
  const add = (path, side, text, fileId) => {
    if (typeof text !== 'string') throw new Error('Missing retrieval text');
    const id = 's' + (entries.length + 1);
    entries.push({ id, text, path, side });
    catalog.push({ id, path, side, ...(fileId ? { fileId } : {}) });
  };
  for (const file of snapshot.files) {
    if (!file || typeof file.path !== 'string' || !file.path || paths.has(file.path) || typeof file.id !== 'string' || !file.id || identities.has(file.id) || !['reviewable', 'blocked', 'excluded'].includes(file.eligibility)) throw new Error('Invalid retrieval file');
    paths.set(file.path, file); identities.add(file.id);
    if (file.eligibility !== 'reviewable') continue;
    add(file.path, 'old', file.left?.text, file.id);
    add(file.path, 'new', file.right?.text, file.id);
  }
  const seenContext = new Set();
  for (const item of snapshot.context) {
    if (!item || typeof item.path !== 'string' || !item.path || seenContext.has(item.path) || typeof item.text !== 'string') throw new Error('Invalid retrieval context');
    seenContext.add(item.path);
    const changed = paths.get(item.path);
    if (changed) {
      if (changed.eligibility !== 'reviewable' || changed.rightExists === false || changed.right.text !== item.text) throw new Error('Context conflicts with selected changes');
      continue;
    }
    add(item.path, 'context', item.text);
    if (item.oldText !== undefined) {
      if (!snapshot.history || item.oldRevision !== snapshot.history.base || item.revision !== snapshot.history.target || typeof item.oldText !== 'string') throw new Error('Invalid historical context provenance');
      add(item.path, 'context-old', item.oldText);
    }
  }
  const reader = createSnapshotReader(snapshot.id, entries, options);
  return Object.freeze({ ...reader, catalog: () => structuredClone(catalog) });
}
