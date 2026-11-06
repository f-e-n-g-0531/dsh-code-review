import { createHash } from 'node:crypto';
import { createRetrievalScope } from './retrieval-scope.mjs';
import { buildComparisonRoleRanges } from './comparison-role-ranges.mjs';
const contexts = new WeakMap();
const invalid = () => { throw new Error('Invalid approved model comparison context'); };
// Internal host capability only. A snapshot ID or serialized ranges cannot issue it.
export function createModelComparisonContext(snapshot) {
  const approved = structuredClone(snapshot);
  if (!approved || typeof approved.id !== 'string' || !approved.id) invalid();
  const catalog = createRetrievalScope(approved).catalog();
  const sources = catalog.map(source => {
    const file = approved.files.find(file => file.id === source.fileId);
    const item = file ? undefined : (approved.context ?? []).find(item => item.path === source.path);
    const text = file ? (source.side === 'old' ? file.left.text : file.right.text) : source.side === 'context-old' ? item?.oldText : item?.text;
    if (typeof text !== 'string') invalid();
    return { ...source, hash: createHash('sha256').update(text).digest('hex') };
  });
  const token = Object.freeze({}); contexts.set(token, { approved, sources }); return token;
}
// Rebuild only selected final evidence sources using the FULL approved catalog so
// source IDs never change through a narrowed snapshot. Returns detached metadata.
export function modelComparisonRanges(token, sourceIds) {
  if (!contexts.has(token) || !Array.isArray(sourceIds) || !sourceIds.length || sourceIds.length > 16 || new Set(sourceIds).size !== sourceIds.length) invalid();
  const { approved, sources } = contexts.get(token);
  if (sourceIds.some(id => !sources.some(source => source.id === id))) invalid();
  return structuredClone(buildComparisonRoleRanges(approved, { sourceIds }));
}
export function approvedModelComparisonRanges(token, snapshotId, sourceIds) {
  if (!contexts.has(token) || !Array.isArray(sourceIds) || !sourceIds.length || sourceIds.length > 8 || new Set(sourceIds).size !== sourceIds.length) invalid();
  const { approved, sources } = contexts.get(token);
  if (snapshotId !== approved.id || sourceIds.some(id => !sources.some(source => source.id === id))) invalid();
  return { sources: structuredClone(sources.filter(source => sourceIds.includes(source.id))), ...buildComparisonRoleRanges(approved, { sourceIds }) };
}
