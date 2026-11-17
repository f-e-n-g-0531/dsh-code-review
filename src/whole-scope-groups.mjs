import { inferFileRelations } from './file-relations.mjs';
import { buildReviewGroups } from './review-groups.mjs';

export const GROUP_NOTICE = 'Relation hints only, not semantic proof or completed cross-file coverage. completeMembers means membership present, not review complete. Cross-batch sources remain available on demand in the original approved catalog.';

export function wholeScopeGroups(members, migration, relationFiles = members) {
  // Reuse the bounded navigation graph; no excluded/blocked member is restored.
  const ids = new Set(members.map(file => file.id));
  const edges = [...(migration?.links ?? []).filter(link => ids.has(link.from) && ids.has(link.to)).map(link => ({ from: link.from, to: link.to, reason: 'migration-route' })), ...inferFileRelations(relationFiles).filter(link => ids.has(link.from) && ids.has(link.to))].slice(0, 2000);
  const bounded = buildReviewGroups(members, edges, { maxFiles: 20 });
  // The reusable scheduler caps a local traversal at 20. Rejoin connected
  // components here: logical groups are not split until real wire capacity.
  const parent = new Map(members.map(file => [file.id, file.id]));
  const root = id => { while (parent.get(id) !== id) id = parent.get(id); return id; };
  for (const link of bounded.links) parent.set(root(link.to), root(link.from));
  const components = new Map();
  for (const id of bounded.groups.flatMap(group => group.fileIds)) {
    const key = root(id);
    if (!components.has(key)) components.set(key, []);
    components.get(key).push(id);
  }
  const groups = [...components.values()].map((fileIds, i) => ({ id: 'g' + (i + 1), fileIds }));
  return { groups, links: bounded.links.map(link => ({ ...link, split: false })), notice: GROUP_NOTICE };
}

export function projectWholeGroups(grouping, fileIds) {
  const ids = new Set(fileIds);
  const groups = grouping.groups.filter(group => group.fileIds.some(id => ids.has(id))).map(group => ({
    id: group.id, fileIds: group.fileIds,
    includedFileIds: group.fileIds.filter(id => ids.has(id)), omittedFileIds: group.fileIds.filter(id => !ids.has(id)),
    completeMembers: group.fileIds.every(id => ids.has(id)),
  }));
  const links = grouping.links.filter(link => ids.has(link.from) || ids.has(link.to)).map(link => ({
    ...link, crossBatch: !(ids.has(link.from) && ids.has(link.to)),
  }));
  return { groups, links, notice: GROUP_NOTICE };
}

export function mapWholeGroups(grouping, batches, oversized) {
  const batchIds = fileId => batches.filter(batch => batch.fileIds.includes(fileId)).map(batch => batch.id);
  return { ...grouping, groups: grouping.groups.map(group => ({ ...group,
    batchIds: [...new Set(group.fileIds.flatMap(batchIds))], oversizedFileIds: group.fileIds.filter(id => oversized.some(file => file.fileId === id)),
  })), links: grouping.links.map(link => {
    const fromBatchIds = batchIds(link.from), toBatchIds = batchIds(link.to);
    return { ...link, fromBatchIds, toBatchIds, crossBatch: !fromBatchIds.some(id => toBatchIds.includes(id)) };
  }) };
}
