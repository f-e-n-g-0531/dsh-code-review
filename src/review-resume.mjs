import { hash } from './content.mjs';
import { validateBusinessGroups } from './business-groups.mjs';
import { prepareStageGenerations } from './review-stage-state.mjs';
import { createStageContinuation } from './stage-continuation.mjs';

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
const digest = value => hash(JSON.stringify(canonical(value)));

const MAX_BYTES = 8 * 1024 * 1024;
const stageEnabled = options => options?.execution?.enableStageContinuation === true || options?.enableStageContinuation === true;
const invalid = () => { throw new Error('Invalid stage resume checkpoint'); };
const exact = (value, keys) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) invalid(); };
const RECEIPT_KEYS = new Set(['receiptId', 'receipts', 'retrievalAudit', 'retrieved', 'resolveEvidence']);
function privateClone(value, { stripReceipts = false } = {}, seen = new Set(), depth = 0, budget = { nodes: 0, bytes: 0 }) {
  if (++budget.nodes > 300000 || depth > 32) invalid();
  if (typeof value === 'string') { budget.bytes += Buffer.byteLength(value); if (budget.bytes > MAX_BYTES) invalid(); return value; }
  if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || seen.has(value) || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  if (Array.isArray(value) && (value.length > 100000 || Object.keys(value).length !== value.length)) invalid();
  seen.add(value); const out = Array.isArray(value) ? [] : {};
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    if (typeof key !== 'string' || ['__proto__', 'constructor', 'toJSON', 'prototype'].includes(key)) invalid();
    const d = Object.getOwnPropertyDescriptor(value, key); if (!d.enumerable || !Object.hasOwn(d, 'value')) invalid();
    // Host report objects use optional undefined fields; normalize only exports.
    // Imported checkpoints remain JSON-only and reject undefined explicitly.
    if (stripReceipts && !Array.isArray(value) && d.value === undefined) continue;
    if (RECEIPT_KEYS.has(key)) { if (stripReceipts) continue; invalid(); }
    out[key] = privateClone(d.value, { stripReceipts }, seen, depth + 1, budget);
  }
  seen.delete(value);return out;
}
function bounded(value) { if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) invalid(); return value; }
function continuationState(snapshot, wrapper) {
  exact(wrapper, ['options', 'state']);
  const o = wrapper.options, cp = wrapper.state;
  exact(o, ['rounds', 'maxInputBytes', 'enableMigrationContracts', 'enableMigrationRegression']);
  if (!Number.isSafeInteger(o.rounds) || o.rounds < 1 || o.rounds > 50 || !Number.isSafeInteger(o.maxInputBytes) || o.maxInputBytes < 1 || o.maxInputBytes > 16 * 1024 * 1024 || typeof o.enableMigrationContracts !== 'boolean' || typeof o.enableMigrationRegression !== 'boolean' || !Array.isArray(cp?.units)) invalid();
  const units = cp.units.map(({ id, kind, fileIds, dependencies }) => ({ id, kind, fileIds, dependencies }));
  const machine = createStageContinuation(snapshot, o, { completedPrimary: cp.completedPrimary, units, maxAttempts: cp.maxAttempts, checkpoint: cp });
  // Keep the original checkpoint (not the machine's running->pending projection).
  // This is historical bookkeeping only, never automatically applied to a new run.
  machine.summary();
  return { options: structuredClone(o), state: structuredClone(cp) };
}
function prepareV2(value, snapshot) {
  exact(value, ['schemaVersion', 'snapshotId', 'identityHash', 'completed', 'businessGrouping', 'interactions', 'stageGenerations', 'continuation']);
  if (!Array.isArray(value.stageGenerations)) invalid();
  const generations = prepareStageGenerations(snapshot, value.stageGenerations);
  const done = new Set(value.completed.map(item => item.fileId));
  if (generations.some(row => row.phase !== 'primary' || done.has(row.fileId) || row.needsFreshProvenance)) invalid();
  const result = { ...value, stageGenerations: generations };
  if (value.continuation !== undefined) result.continuation = continuationState(snapshot, value.continuation);
  return bounded(result);
}

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
  if (stageEnabled(options)) {
    result.schemaVersion = 2;
    result.stageGenerations = prepareStageGenerations(snapshot, report.stageGenerations ?? []).filter(row => row.phase === 'primary' && !completed.some(item => item.fileId === row.fileId));
    if (report.continuation !== undefined) result.continuation = continuationState(snapshot, privateClone({ options: report.continuationOptions, state: report.continuation }));
    return prepareV2(bounded(privateClone(result, { stripReceipts: true })), snapshot);
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024) throw new Error('Resume checkpoint exceeds storage limit');
  return result;
}

export function validateResumeState(value, snapshot, options) {
  // Select the version without invoking a caller-supplied accessor or inherited
  // schema property before the strict schema-two descriptor scan.
  if (!value || typeof value !== 'object') invalid();
  const version = Object.getOwnPropertyDescriptor(value, 'schemaVersion');
  if (!version || !Object.hasOwn(version, 'value')) invalid();
  const v2 = version.value === 2;
  if (v2) { if (!stageEnabled(options)) invalid(); value = bounded(privateClone(value)); }
  if (!value || ![1, ...(stageEnabled(options) ? [2] : [])].includes(value.schemaVersion) || value.snapshotId !== snapshot?.id || value.identityHash !== digest({ snapshot, options }) || !Array.isArray(value.completed) || value.completed.length > snapshot.files.length) throw new Error('Resume identity mismatch; capture a fresh independent review');
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
  return v2 ? prepareV2(value, snapshot) : structuredClone(value);
}

export function resumePreview(state, sourceJobId) {
  if (state.schemaVersion === 2) return { sourceJobId, reusableFiles: state.completed.length, fileIds: state.completed.map(item => item.fileId), reusableGenerations: state.stageGenerations.length, stageFileIds: [...new Set(state.stageGenerations.map(item => item.fileId))], notice: 'Exact-identity accepted primary generations may skip generation only. Pending chains are not completed reviews. Verification always runs again with fresh independent receipts; secondary stages restart at a fresh provenance boundary. Saved continuation is historical bookkeeping, not fresh completion or a new attempt allowance. Fresh preview confirmation and model authorization remain required.' };
  return { sourceJobId, reusableFiles: state.completed.length, fileIds: state.completed.map(item => item.fileId), notice: 'Only exact-identity completed file chains are reusable. Pending/interrupted stages run again; old findings retain prior-run provenance, not fresh model evidence. Fresh preview confirmation and model authorization are still required.' };
}
