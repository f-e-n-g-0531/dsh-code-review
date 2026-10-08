// Audit only successful reads from this synthesis generation, never prior batches/searches.
export function validateSynthesisReads(findings, changes, reads, catalog, fileId, snapshotId) {
 const sources = new Map(catalog.map(s => [s.id, s]));
 for (const finding of findings) {
  for (const id of finding.attribution.editIds) {
   const edit = changes.edits.find(e => e.id === id);
   const covered = ['old', 'new'].some(side => {
    const range = edit?.[side];
    return range?.count > 0 && reads.some(r => {
     const source = sources.get(r.sourceId);
     return r.kind === 'read' && r.snapshotId === snapshotId && source?.fileId === fileId && source.side === side && r.start <= range.start && r.start + r.count >= range.start + range.count;
    });
   });
   if (!covered) throw new Error('Synthesis referenced edit was not read in this generation');
  }
 }
}
