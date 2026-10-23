import { hash } from './content.mjs';
import { validateBusinessGroups } from './business-groups.mjs';

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
const digest = value => hash(JSON.stringify(canonical(value)));
const safeFile = file => !file?.stageFailures?.length && !file?.reviewPasses?.some(pass => pass.status !== 'completed') && !file?.windowCoverage?.pending?.length && file?.status === 'completed' && file.resumeEligible === true && !file.retrievalLimited && (!file.synthesisStatus || file.synthesisStatus === 'completed') && (!file.verificationStatus || !['pending', 'failed'].includes(file.verificationStatus));

// Host-private, schema-versioned completed-chain state. A previous result grants
// neither source authority nor model approval. Exact whole-snapshot binding is
// deliberately conservative: any changed context/rule/source invalidates reuse.
export function buildResumeState(snapshot, options, report) {
  if (typeof snapshot?.id !== 'string' || !Array.isArray(snapshot.files) || !report || !Array.isArray(report.files) || !Array.isArray(report.findings)) throw new Error('Invalid resume checkpoint');
  const approved = new Map(snapshot.files.filter(file => file.eligibility === 'reviewable').map(file => [file.id, file]));
  const completed = [];
  for (const state of report.files) {
    const file = approved.get(state.fileId);
    if (!file || file.path !== state.path || !safeFile(state)) continue;
    if (completed.some(item => item.fileId === file.id)) throw new Error('Duplicate resume file');
    const findings = report.findings.filter(finding => finding.fileId === file.id);
    if (findings.some(finding => finding.verification?.status !== 'completed') || (report.interactions ?? []).some(item => item.fileIds?.includes(file.id) && item.status !== 'completed')) continue;
    completed.push({ fileId: file.id, path: file.path, state: structuredClone(state), findings: structuredClone(findings), limitations: structuredClone((report.limitations ?? []).filter(item => item.fileId === file.id)) });
  }
  let businessGrouping;
  if (report.businessGrouping?.groups) {
    validateBusinessGroups({ groups: report.businessGrouping.groups.map(group => ({ fileIds: group.fileIds, reason: group.reason })) }, snapshot.files);
    businessGrouping = structuredClone(report.businessGrouping);
  }
  const interactions = structuredClone((report.interactions ?? []).filter(item => Array.isArray(item.fileIds) && item.fileIds.length && item.status === 'completed' && item.fileIds.every(id => completed.some(row => row.fileId === id))));
  const identity = digest({ snapshot, options });
  const result = { schemaVersion: 1, snapshotId: snapshot.id, identityHash: identity, completed, ...(businessGrouping ? { businessGrouping } : {}), interactions };
  if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024) throw new Error('Resume checkpoint exceeds storage limit');
  return result;
}

export function validateResumeState(value, snapshot, options) {
  if (!value || value.schemaVersion !== 1 || value.snapshotId !== snapshot?.id || value.identityHash !== digest({ snapshot, options }) || !Array.isArray(value.completed) || value.completed.length > snapshot.files.length) throw new Error('Resume identity mismatch; capture a fresh independent review');
  const seen = new Set();
  for (const item of value.completed) {
    const source = snapshot.files.find(file => file.id === item?.fileId && file.path === item.path && file.eligibility === 'reviewable');
    if (!source || seen.has(item.fileId) || !safeFile(item.state) || item.state.fileId !== item.fileId || item.state.path !== item.path || !Array.isArray(item.findings) || item.findings.some(finding => finding?.fileId !== item.fileId || finding.verification?.status !== 'completed') || !Array.isArray(item.limitations) || item.limitations.some(item => item?.fileId !== source.id)) throw new Error('Invalid completed resume chain');
    seen.add(item.fileId);
  }
  if (value.businessGrouping !== undefined) {
    if (!Array.isArray(value.businessGrouping?.groups)) throw new Error('Invalid resume business partition');
    validateBusinessGroups({ groups: value.businessGrouping.groups.map(group => ({ fileIds: group.fileIds, reason: group.reason })) }, snapshot.files);
  }
  if (!Array.isArray(value.interactions) || value.interactions.some(item => !Array.isArray(item?.fileIds) || !item.fileIds.length || item.status !== 'completed' || item.fileIds.some(id => !seen.has(id)))) throw new Error('Invalid resume interactions');
  return structuredClone(value);
}

export function resumePreview(state, sourceJobId) {
  return { sourceJobId, reusableFiles: state.completed.length, fileIds: state.completed.map(item => item.fileId), notice: 'Only exact-identity completed file chains are reusable. Pending/interrupted stages run again; old findings retain prior-run provenance, not fresh model evidence. Fresh preview confirmation and model authorization are still required.' };
}
