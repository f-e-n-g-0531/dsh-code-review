import { createHash } from 'node:crypto';

// Pure member partition, never permission to retry sent work. The caller must
// validate its host-owned recovery trigger, join the parent and bound the depth.
export function splitWholeBatch(batch) {
  if (!batch || typeof batch.payload !== 'string' || typeof batch.instructions !== 'string' || !Array.isArray(batch.fileIds) || !(batch.changes instanceof Map)) throw new TypeError('Invalid whole batch');
  const input = JSON.parse(batch.payload), rows = input?.reviews;
  if (input?.sourceMode !== 'group-primary' || !Array.isArray(rows) || rows.length !== batch.fileIds.length || rows.length > 200 || new Set(batch.fileIds).size !== rows.length || rows.some((row, i) => typeof row?.fileId !== 'string' || !row.fileId || row.fileId !== batch.fileIds[i] || !batch.changes.has(row.fileId))) throw new TypeError('Invalid whole batch members');
  if (rows.length < 2) return null;
  const midpoint = Math.ceil(rows.length / 2);
  return [rows.slice(0, midpoint), rows.slice(midpoint)].map(members => {
    const fileIds = members.map(row => row.fileId), ids = new Set(fileIds);
    const scoped = { ...input, reviews: members };
    if (Array.isArray(input.rejectionBranchNavigation)) scoped.rejectionBranchNavigation=input.rejectionBranchNavigation.filter(row=>ids.has(row.fileId));
    if (Array.isArray(input.migrationRouteHints)) {
      scoped.migrationRouteHints=input.migrationRouteHints.filter(hint=>ids.has(hint.candidateFileId));
      if(input.migrationRouteScope)scoped.migrationRouteScope={...input.migrationRouteScope,includedHints:scoped.migrationRouteHints.length};
    }
    const payload = JSON.stringify(scoped);
    return { id: 'whole-' + createHash('sha256').update(payload).digest('hex'), payload, instructions: batch.instructions, fileIds, changes: new Map(fileIds.map(id => [id, structuredClone(batch.changes.get(id))])) };
  });
}
