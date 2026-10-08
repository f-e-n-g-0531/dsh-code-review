import { inferContextRelations } from './context-relations.mjs';
import { defectGuidance } from './defect-guidance.mjs';
import { changeMap } from './change-map.mjs';

// Pure navigation over one already approved snapshot. No source reads or model sends.
export function prepareInteractionInput(snapshot, group, measure) {
 if (!snapshot || typeof snapshot.id !== 'string' || !Array.isArray(snapshot.files) || !group || !Array.isArray(group.fileIds) || group.fileIds.length < 2 || group.fileIds.length > 4 || new Set(group.fileIds).size !== group.fileIds.length || typeof measure !== 'function') throw new Error('Invalid interaction group');
 const files = group.fileIds.map(id => {
  const matches = snapshot.files.filter(f => f.id === id);
  if (matches.length !== 1 || matches[0].eligibility !== 'reviewable' || typeof matches[0].left?.text !== 'string' || typeof matches[0].right?.text !== 'string') throw new Error('Interaction file outside approved reviewable scope');
  const file = matches[0], changes = changeMap(file.left.text, file.right.text);
  if (changes.status !== 'changed' || changes.precision !== 'exact') return { fileId: file.id, path: file.path, unavailable: true };
  return { fileId: file.id, path: file.path, defectGuidance: defectGuidance(file.path,file.rightExists===false?file.left.text:file.right.text), edits: changes.edits.map(({ id, old, new: after }) => ({ id, old, new: after })) };
 });
 if (group.fileIds.filter(id => { const file = snapshot.files.find(f => f.id === id); return file.left.text !== file.right.text; }).length < 2) return { status: 'not-applicable', fileIds: [...group.fileIds] };
 if (files.some(f => f.unavailable)) return { status: 'blocked', reason: 'exact-edit-analysis-unavailable', fileIds: [...group.fileIds] };
 const contextRelations = group.fileIds.flatMap(id=>inferContextRelations(snapshot,snapshot.files.find(f=>f.id===id)).map(relation=>({primaryFileId:id,...relation})));
 const payload = JSON.stringify({ contextRelations, contextRelationNotice:'Approved-context import/include and call binding hints only; not a call graph, complete caller coverage, semantic binding or causal evidence. Historical contextSide/contextVersion must not be interchanged.', snapshotId: snapshot.id, sourceMode: 'file-interaction', groupId: group.id, files, context: snapshot.context ?? [], rules: snapshot.rules ?? [], notice: 'Only combined defects across at least two listed files; directories are navigation not evidence. Read referenced edit source sides from approved catalog in this generation. Return ordinary findings with fileId of one listed primary and exact original line anchor; attribution.editIds references only that primary. Add interaction:{editRefs:[{fileId,editId}]} including all involved edits across at least two files. This sourceMode overrides single-primary input instructions. Retain original primary anchor and file-qualified edit references. Unsupported conclusions become limitations; no repeated single-file issues. Relations and read coverage are not causal proof.' });
 const budget = measure(payload);
 return { status: budget.fits ? 'ready' : 'blocked', reason: budget.fits ? undefined : 'input-budget', fileIds: [...group.fileIds], payload, budget };
}
