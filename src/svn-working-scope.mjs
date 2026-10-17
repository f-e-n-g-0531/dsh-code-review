// Describes observed evidence only; never infers a complete working tree from status.
export function workingScopeEvidence(rootSource, files) {
  const revisions = [...new Set(files
    .filter(f => f.eligibility === 'reviewable' && f.workingSource && /^[0-9]+$/.test(f.workingSource.revision))
    .map(f => f.workingSource.revision))].sort((a, b) => Number(a) - Number(b));
  const sparse = files
    .filter(f => f.workingSource?.kind === 'dir' && f.workingSource.depth !== 'infinity')
    .map(f => ({ path: f.path, depth: f.workingSource.depth ?? 'unknown' }));
  if (rootSource.depth !== 'infinity' && !sparse.some(s => s.path === '.')) sparse.unshift({ path: '.', depth: rootSource.depth ?? 'unknown' });
  return {
    root: rootSource,
    observedBaseRevisions: revisions,
    mixedObservedRevisions: revisions.length > 1,
    sparseDirectories: sparse,
    inventoryComplete: false,
    notice: 'Only selected/observed change metadata is described. Mixed revisions bind each node BASE independently, not a common historical tree. Sparse or unenumerated paths are not deletion evidence or reviewed coverage; no update/deepen/external traversal was performed.',
  };
}
