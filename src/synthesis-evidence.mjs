// Audit only successful reads from this synthesis generation, never prior batches/searches.
export function validateSynthesisReads(findings, changes, reads, catalog, fileId, snapshotId) {
 const sources = new Map(catalog.map(s => [s.id, s]));
 const intervals = new Map();
 for (const read of reads) {
  const source = sources.get(read.sourceId);
  if (read.kind !== 'read' || read.snapshotId !== snapshotId || source?.fileId !== fileId || !['old', 'new'].includes(source.side)) continue;
  if (!Number.isSafeInteger(read.start) || read.start < 1 || !Number.isSafeInteger(read.count) || read.count < 1 || !Number.isSafeInteger(read.start + read.count)) continue;
  const ranges = intervals.get(read.sourceId) ?? [];
  ranges.push({ start: read.start, end: read.start + read.count });
  intervals.set(read.sourceId, ranges);
 }
 // Never join different source identities, even when their file and side match.
 for (const [id, ranges] of intervals) {
  const merged = [];
  for (const range of ranges.sort((a, b) => a.start - b.start)) {
   const last = merged.at(-1);
   if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
   else merged.push({ ...range });
  }
  intervals.set(id, merged);
 }
 for (const finding of findings) {
  for (const id of finding.attribution.editIds) {
   const edit = changes.edits.find(e => e.id === id);
   const covered = ['old', 'new'].some(side => {
    const range = edit?.[side];
    return range?.count > 0 && [...intervals].some(([sourceId, ranges]) => sources.get(sourceId).side === side && ranges.some(r => r.start <= range.start && r.end >= range.start + range.count));
   });
   if (!covered) throw new Error('Synthesis referenced edit was not read in this generation');
  }
 }
}
