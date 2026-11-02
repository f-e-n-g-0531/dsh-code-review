import { hash } from './content.mjs';
import { validateBusinessGroups } from './business-groups.mjs';
import { prepareStageGenerations } from './review-stage-state.mjs';
import { createStageContinuation } from './stage-continuation.mjs';

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
const digest = value => hash(JSON.stringify(canonical(value)));

const MAX_BYTES = 8 * 1024 * 1024;
const stageEnabled = options => options?.execution?.enableStageContinuation === true || options?.enableStageContinuation === true;
const invalid = () => { throw new Error('Invalid stage resume checkpoint'); };
// Private export-only sentinel: never infer capacity from an arbitrary error/code.
class ResumeStorageCapacityError extends Error {
  constructor() { super('Resume checkpoint exceeds storage capacity'); this.code = 'RESUME_STORAGE_CAPACITY_EXCEEDED'; }
}
const capacity = mode => { if (mode === 'export') throw new ResumeStorageCapacityError(); if (mode !== 'scan') invalid(); };
export const RESUME_CHECKPOINT_CAPACITY_LIMITATION = '续审检查点容量受限：仅保存适配容量的完整历史单元，未保存部分将重新执行；不影响本次发现或授予证据权限。';
const exact = (value, keys) => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) invalid(); };
const RECEIPT_KEYS = new Set(['receiptId', 'receipts', 'retrievalAudit', 'retrieved', 'resolveEvidence']);
function privateClone(value, { stripReceipts = false, capacityMode } = {}, seen = new Set(), depth = 0, budget = { nodes: 0, bytes: 0 }) {
  if (depth > 32) invalid();
  if (++budget.nodes > 300000) capacity(capacityMode);
  if (typeof value === 'string') { budget.bytes += Buffer.byteLength(value); if (budget.bytes > MAX_BYTES) capacity(capacityMode); return value; }
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
    out[key] = privateClone(d.value, { stripReceipts, capacityMode }, seen, depth + 1, budget);
  }
  seen.delete(value);return out;
}
function bounded(value, capacityMode) { if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) capacity(capacityMode); return value; }

function exportWithinCapacity(value) {
  const cloned = bounded(privateClone(value, { stripReceipts: true, capacityMode: 'export' }), 'export');
  // Accepted-stage import has a stricter aggregate node budget than the wrapper.
  const stageBudget = { nodes: 0, bytes: 0 };
  privateClone(cloned.stageGenerations, { capacityMode: 'export' }, new Set(), 0, stageBudget);
  if (stageBudget.nodes > 200000) throw new ResumeStorageCapacityError();
  return cloned;
}
function capacityFits(value) {
  try { exportWithinCapacity(value); return true; }
  catch (error) { if (error instanceof ResumeStorageCapacityError) return false; throw error; }
}
function boundedExport(result, report, snapshot) {
  // Every unit has already passed structural and semantic checks before admission.
  // Only the serialized storage/node aggregate may degrade; unknown errors escape.
  if (capacityFits(result)) return prepareV2(exportWithinCapacity(result), snapshot);
  const next = { schemaVersion: 2, snapshotId: result.snapshotId, identityHash: result.identityHash, completed: [], interactions: [], stageGenerations: [] };
  exportWithinCapacity(next); // Even an unusable identity shell must fail normally.
  const omitted = { completed: 0, stageGenerations: 0, interactions: 0, continuation: 0, businessGrouping: 0 };
  for (const row of result.completed) {
    const candidate = { ...next, completed: [...next.completed, row] };
    if (capacityFits(candidate)) next.completed.push(row); else omitted.completed++;
  }
  if (result.businessGrouping !== undefined) {
    if (capacityFits({ ...next, businessGrouping: result.businessGrouping })) next.businessGrouping = result.businessGrouping; else omitted.businessGrouping++;
  }
  for (const row of result.stageGenerations) {
    if (capacityFits({ ...next, stageGenerations: [...next.stageGenerations, row] })) next.stageGenerations.push(row); else omitted.stageGenerations++;
  }
  if (result.continuation !== undefined) {
    // Historical continuation cannot imply completion for a dropped primary unit.
    if (!omitted.stageGenerations && !omitted.completed && capacityFits({ ...next, continuation: result.continuation })) next.continuation = result.continuation; else omitted.continuation++;
  }
  const kept = new Set(next.completed.map(row => row.fileId));
  for (const row of result.interactions) {
    if (row.fileIds.every(id => kept.has(id)) && capacityFits({ ...next, interactions: [...next.interactions, row] })) next.interactions.push(row); else omitted.interactions++;
  }
  const limitation = { code: 'RESUME_CHECKPOINT_CAPACITY_EXCEEDED', text: RESUME_CHECKPOINT_CAPACITY_LIMITATION, omitted };
  report.resumeLimitations ??= [];
  const previous = report.resumeLimitations.findIndex(row => row.code === limitation.code);
  if (previous < 0) report.resumeLimitations.push(limitation); else report.resumeLimitations[previous] = limitation;
  report.limitations ??= [];
  if (!report.limitations.some(row => row.text === limitation.text)) report.limitations.push({ text: limitation.text });
  return prepareV2(exportWithinCapacity(next), snapshot);
}
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
  if (typeof snapshot?.id !== 'string' || !Array.isArray(snapshot.files) || !report || typeof report !== 'object') throw new Error('Invalid resume checkpoint');
  if (stageEnabled(options)) {
    // Scan the entire export payload before any filtering/size admission. Unlike
    // imports this scan records no storage entitlement, but never executes hooks.
    if (![Object.prototype, null].includes(Object.getPrototypeOf(report))) invalid();
    const noticeDescriptor = Object.getOwnPropertyDescriptor(report, 'resumeLimitations');
    if (noticeDescriptor && (!noticeDescriptor.enumerable || !Object.hasOwn(noticeDescriptor, 'value') || !Array.isArray(noticeDescriptor.value))) invalid();
    const keys = ['files', 'findings', 'limitations', 'interactions', 'businessGrouping', 'stageGenerations', 'continuationOptions', 'continuation', 'resumeLimitations'];
    const candidate = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(report, key);
      if (descriptor) { if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid(); candidate[key] = descriptor.value; }
    }
    const safe = privateClone(candidate, { stripReceipts: true, capacityMode: 'scan' });
    // Preserve mutation target only for explicit capacity notices below.
    return buildStageResumeState(snapshot, options, safe, report);
  }
  return buildStageResumeState(snapshot, options, report, report);
}

function buildStageResumeState(snapshot, options, report, noticeTarget) {
  if (!Array.isArray(report.files) || !Array.isArray(report.findings)) throw new Error('Invalid resume checkpoint');
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
    const stageKeys = new Set();
    result.stageGenerations = (report.stageGenerations ?? []).flatMap(record => {
      const [row] = prepareStageGenerations(snapshot, [record]);
      if (stageKeys.has(row.key)) invalid(); stageKeys.add(row.key);
      return row.phase === 'primary' && !completed.some(item => item.fileId === row.fileId) ? [row] : [];
    });
    if (report.continuation !== undefined) result.continuation = continuationState(snapshot, { options: report.continuationOptions, state: report.continuation });
    // Check every completed chain, including units later omitted for capacity.
    for (const item of completed) {
      const file = approved.get(item.fileId);
      if (!file || !safeFile(item.state) || item.state.fileId !== item.fileId || item.state.path !== item.path ||
          !Array.isArray(item.findings) || item.findings.some(f => f?.fileId !== item.fileId || f.verification?.status !== 'completed') ||
          !Array.isArray(item.limitations) || item.limitations.some(row => row?.fileId !== item.fileId)) throw new Error('Invalid completed resume chain');
    }
    return boundedExport(result, noticeTarget, snapshot);
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
