import { changeMap } from './change-map.mjs';
import { validateFindings } from './review.mjs';
import { validateSynthesisReads } from './synthesis-evidence.mjs';

// File-qualified references prevent identical e1 IDs in different files being confused.
export function validateInteractionFindings(response, snapshot, group, reads, catalog) {
 if (typeof response === 'string') { if (Buffer.byteLength(response) > 128 * 1024) throw new Error('Interaction response too large'); response = JSON.parse(response); }
 if (!response || Buffer.byteLength(JSON.stringify(response)) > 128 * 1024 || !Array.isArray(response.findings) || response.findings.length > 50 || !Array.isArray(response.limitations) || response.limitations.length > 50 || response.limitations.some(s => typeof s !== 'string' || !s.trim() || s.length > 8000)) throw new Error('Invalid interaction response');
 if (!group || !Array.isArray(group.fileIds) || group.fileIds.length < 2 || group.fileIds.length > 4 || new Set(group.fileIds).size !== group.fileIds.length) throw new Error('Invalid interaction scope');
 const files = new Map();
 for (const id of group.fileIds) {
  const matches = snapshot.files.filter(f => f.id === id);
  if (matches.length !== 1 || matches[0].eligibility !== 'reviewable') throw new Error('Interaction file outside approved scope');
  files.set(id, matches[0]);
 }
 const findings = response.findings.map(raw => {
  const file = files.get(raw?.fileId);
  if (!file) throw new Error('Interaction primary outside group');
  const refs = raw.interaction?.editRefs;
  if (!Array.isArray(refs) || refs.length < 2 || refs.length > 50 || refs.some(r => !r || Object.keys(r).sort().join(',') !== 'editId,fileId' || typeof r.editId !== 'string' || !files.has(r.fileId))) throw new Error('Invalid file-qualified interaction references');
  if (new Set(refs.map(r => JSON.stringify([r.fileId, r.editId]))).size !== refs.length || new Set(refs.map(r => r.fileId)).size < 2) throw new Error('Interaction requires distinct edits across multiple files');
  const finding = validateFindings({ findings: [raw], limitations: [] }, file).findings[0];
  const primary = refs.filter(r => r.fileId === file.id).map(r => r.editId);
  if (finding.attribution.status !== 'references-validated' || !primary.length || primary.some(id => !finding.attribution.editIds.includes(id)) || finding.attribution.editIds.some(id => !primary.includes(id))) throw new Error('Interaction primary attribution mismatch');
  const primaryChanges = changeMap(file.left.text, file.right.text);
  if (finding.anchor.kind !== 'line' || !primaryChanges.edits.some(e => { const range = e[finding.anchor.side]; return primary.includes(e.id) && range.count > 0 && finding.anchor.start < range.start + range.count && finding.anchor.end >= range.start; })) throw new Error('Interaction anchor must overlap a referenced primary edit');
  for (const id of new Set(refs.map(r => r.fileId))) {
   const target = files.get(id), changes = changeMap(target.left.text, target.right.text);
   const editIds = refs.filter(r => r.fileId === id).map(r => r.editId);
   if (changes.status !== 'changed' || changes.precision !== 'exact' || editIds.some(editId => !changes.edits.some(e => e.id === editId))) throw new Error('Unknown or inexact interaction edit');
   validateSynthesisReads([{ attribution: { editIds } }], changes, reads, catalog, id, snapshot.id);
  }
  return { ...finding, interaction: { status: 'references-and-reads-validated', causality: 'unverified', editRefs: refs.map(r => ({ ...r })) } };
 });
 return { findings, limitations: [...response.limitations] };
}
