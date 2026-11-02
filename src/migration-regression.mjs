import { changeMap } from './change-map.mjs';
import { contextSources } from './context-identity.mjs';
import { hash } from './content.mjs';

const contexts = new WeakSet();
const positive = value => Number.isSafeInteger(value) && value > 0;
const overlap = (ref, range) => range?.count > 0 && ref.start < range.start + range.count && range.start < ref.start + ref.count;
const fail = () => { throw new Error('Invalid approved migration regression contract'); };
const freeze = value => { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; };

// Compile host navigation against the exact approved snapshot. No model-provided
// contract object or copied input metadata can replace this invocation capability.
export function prepareMigrationRegression(snapshot, scope, contracts, candidates) {
  if (!snapshot || typeof snapshot.id !== 'string' || snapshot.projectScope || snapshot.files?.some(file => file.reviewMode === 'project') || !Array.isArray(snapshot.files) || !Array.isArray(contracts) || contracts.length > 100 || !Array.isArray(candidates)) fail();
  const catalog = scope.catalog();
  const role = (value, expectedSide) => {
    if (!value || typeof value.sourceId !== 'string') fail();
    const matches = catalog.filter(source => source.id === value.sourceId);
    if (matches.length !== 1) fail();
    const source = matches[0];
    if (source.path !== (value.sourcePath ?? value.path) || source.side !== value.side || source.fileId !== value.fileId || expectedSide && !(expectedSide === 'old' ? ['old', 'context-old'] : ['new', 'context']).includes(source.side)) fail();
    let body, edits = [];
    if (source.fileId) {
      const file = snapshot.files.find(file => file.id === source.fileId && file.path === source.path && file.eligibility === 'reviewable');
      if (!file || !['old', 'new'].includes(source.side) || value.path !== (source.side === 'old' ? file.oldPath ?? file.path : file.path)) fail();
      body = (source.side === 'old' ? file.left : file.right)?.text;
      if (!Array.isArray(value.editIds) || value.editIds.length > 50 || new Set(value.editIds).size !== value.editIds.length || expectedSide && !value.editIds.length) fail();
      if (value.editIds.length) {
        const changes = changeMap(file.left.text, file.right.text);
        const side = expectedSide ?? source.side;
        if (changes.status !== 'changed' || changes.precision !== 'exact') fail();
        edits = value.editIds.map(id => {
          const edit = changes.edits.find(edit => edit.id === id);
          if (!edit || edit[side].count < 1) fail();
          return { fileId: file.id, editId: edit.id, range: edit[side] };
        });
      }
    } else {
      const item = snapshot.context?.find(item => item.path === source.path);
      if (!item || value.path !== source.path || !Array.isArray(value.editIds) || value.editIds.length) fail();
      body = contextSources(item, snapshot.history).find(item => item.side === source.side)?.text;
    }
    const line = value.line ?? value.callLine;
    if (typeof body !== 'string' || !positive(line) || line > source.lineCount || value.importLine !== undefined && (!positive(value.importLine) || value.importLine > source.lineCount) || edits.length && !edits.some(edit => line >= edit.range.start && line < edit.range.start + edit.range.count)) fail();
    return { sourceId: source.id, side: source.side, path: value.path, sourcePath: source.path, ...(source.fileId ? { fileId: source.fileId } : {}), line, hash: hash(body), edits };
  };
  const ids = new Set(), compiled = [];
  for (const contract of contracts) {
    if (!contract || typeof contract.id !== 'string' || !contract.id || contract.id.length > 200 || ids.has(contract.id) || contract.snapshotId !== snapshot.id || contract.status !== 'navigation-only' || contract.causality !== 'unverified' || !Array.isArray(contract.callers) || contract.callers.length > 32) fail();
    ids.add(contract.id);
    if (!Array.isArray(contract.old) || contract.old.length !== 1 || !Array.isArray(contract.new) || contract.new.length !== 1 || !Array.isArray(contract.candidateFileIds)) fail();
    const oldValue = contract.old[0], newValue = contract.new[0];
    const old = role(oldValue, 'old'), current = role(newValue, 'new');
    if (!old.fileId || !current.fileId || old.fileId === current.fileId || old.sourceId === current.sourceId || !old.edits.length || !current.edits.length) fail();
    const callers = contract.callers.map(caller => {
      const result = role(caller);
      if (!['old', 'new', 'context-old', 'context'].includes(result.side) || caller.targetFileId !== oldValue.fileId && caller.targetFileId !== newValue.fileId) fail();
      return result;
    });
    // The navigation chain has an explicit old-entry caller; a new-role source
    // alone cannot manufacture a migration relation between arbitrary files.
    if (!contract.callers.some(caller => caller.targetFileId === oldValue.fileId && ['old', 'context-old'].includes(caller.side))) fail();
    const fileIds = [...new Set([old.fileId, current.fileId].filter(Boolean))];
    if (new Set(contract.candidateFileIds).size !== contract.candidateFileIds.length || contract.candidateFileIds.length !== fileIds.length || contract.candidateFileIds.some(id => !fileIds.includes(id))) fail();
    compiled.push({ id: contract.id, snapshotId: snapshot.id, old, new: current, callers, candidateFileIds: fileIds });
  }
  const context = freeze({ snapshotId: snapshot.id, contracts: compiled, candidates: structuredClone(candidates) });
  contexts.add(context);
  return context;
}

export function migrationRegressionMetadata(context) {
  if (!contexts.has(context)) fail();
  return context.contracts.map(contract => ({ ...structuredClone(contract), old: [structuredClone(contract.old)], new: [structuredClone(contract.new)], status: 'navigation-only', causality: 'unverified' }));
}

export function validateMigrationRegression(value, evidence, fileId, context, candidateId) {
  if (!contexts.has(context) || typeof value.migrationContractId !== 'string') fail();
  const contract = context.contracts.find(contract => contract.id === value.migrationContractId && contract.candidateFileIds.includes(fileId));
  const candidate = context.candidates.find((candidate, index) => candidate.fileId === fileId && (!candidateId || candidateId === 'c' + (index + 1)));
  if (!contract || !candidate || candidate.attribution?.status !== 'references-validated' || !Array.isArray(candidate.attribution.editIds)) fail();
  const ownRoles = [contract.old, contract.new].filter(role => role.fileId === fileId);
  if (!ownRoles.some(role => role.edits.some(edit => candidate.attribution.editIds.includes(edit.editId) && candidate.anchor?.kind === 'line' && candidate.anchor.side === (role.side === 'old' ? 'old' : 'new') && overlap({ start: candidate.anchor.start, count: candidate.anchor.end - candidate.anchor.start + 1 }, edit.range)))) fail();
  let actualEdit = false;
  for (const [field, edge, sides] of [['oldEvidence', contract.old, ['old', 'context-old']], ['newEvidence', contract.new, ['new', 'context']]]) {
    const indices = value[field];
    if (!Array.isArray(indices) || indices.length > 8 || new Set(indices).size !== indices.length) fail();
    let entry = false;
    for (const index of indices) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= evidence.length) fail();
      const ref = evidence[index];
      const binding = [edge, ...contract.callers.filter(role => sides.includes(role.side))].find(role => role.sourceId === ref.sourceId && sides.includes(role.side));
      if (!binding || ref.status !== 'references-validated' || ref.snapshotId !== context.snapshotId || ref.hash !== binding.hash || !positive(ref.start) || !positive(ref.count) || binding !== edge && !(ref.start <= binding.line && binding.line < ref.start + ref.count)) fail();
      if (binding === edge && ref.start <= edge.line && edge.line < ref.start + ref.count) {
        entry = true;
        if (edge.edits.some(edit => overlap(ref, edit.range))) actualEdit = true;
      }
    }
    if (value.classification !== 'uncertain' && !entry) throw new Error('Migration comparison requires both explicit entry roles');
  }
  if (value.classification !== 'uncertain' && !actualEdit) throw new Error('Migration comparison requires actual changed-role evidence');
  return { ...value, oldEvidence: [...value.oldEvidence], newEvidence: [...value.newEvidence], migrationContractId: contract.id, migrationSnapshotId: context.snapshotId, status: 'comparison-references-validated', causality: 'unverified' };
}
