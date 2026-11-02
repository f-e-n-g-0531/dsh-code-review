import { hash } from './content.mjs';
import { changeMap } from './change-map.mjs';
import { reviewChangeMap } from './review-change-map.mjs';
import { changeWindows } from './change-windows.mjs';
import { sourceSegments } from './source-segments.mjs';
import { validateWindowFindings } from './window-findings.mjs';
import { validateAttribution } from './attribution.mjs';

const LIMIT = 8 * 1024 * 1024;
// Host-only accepted generation: member model 50 + group model 50 + host notes 2.
// This is checkpoint/report metadata, never a wider model response or evidence grant.
export const MAX_STAGE_LIMITATIONS = 102;
const PHASES = ['primary', 'window-synthesis', 'file-interaction'];
const DROP = ['verification', 'regression', 'priorRun', 'retrievalAudit', 'receipts', 'receiptId'];
const fail = () => { throw Object.assign(new Error('Invalid accepted stage generation'), { code: 'INVALID_STAGE_GENERATION' }); };
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 8000;
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 1000 && !/[\x00-\x1f]/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function exact(value, allowed) { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(); }
// Private checkpoints are still imported data. Inspect descriptors before JSON
// serialization: getters/toJSON/prototypes must never execute during validation.
function clone(value, seen = new Set(), depth = 0, budget = { nodes: 0, bytes: 0 }) {
  if (++budget.nodes > 200000 || depth > 24) fail();
  if (typeof value === 'string') { budget.bytes += Buffer.byteLength(value); if (budget.bytes > LIMIT) fail(); return value; }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || seen.has(value)) fail();
  if (Object.getPrototypeOf(value) !== (Array.isArray(value) ? Array.prototype : Object.prototype) && Object.getPrototypeOf(value) !== null) fail();
  if (Array.isArray(value) && (value.length > 100000 || Object.keys(value).length !== value.length || Object.keys(value).some((key, index) => key !== String(index)))) fail();
  seen.add(value);
  const output = Array.isArray(value) ? [] : {};
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype', 'toJSON'].includes(key)) fail();
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d.enumerable || !Object.hasOwn(d, 'value')) fail();
    output[key] = clone(d.value, seen, depth + 1, budget);
  }
  seen.delete(value);
  return output;
}

export function stageKey(fileId, { phase, round = 1, windowIds = [], groupId } = {}) {
  if (!identity(fileId) || !PHASES.includes(phase) || !Number.isSafeInteger(round) || round < 1 || round > 50 || !Array.isArray(windowIds) || windowIds.length > 100000 || windowIds.some(id => !identity(id)) || new Set(windowIds).size !== windowIds.length || (groupId !== undefined && !identity(groupId)) || (phase === 'file-interaction' && !groupId)) fail();
  return JSON.stringify([fileId, phase, round, [...windowIds].sort(), groupId ?? null]);
}

function normalizeFinding(raw, file, changes, phase, files) {
  exact(raw, ['id', 'fileId', 'path', 'severity', 'title', 'evidence', 'trigger', 'impact', 'suggestion', 'anchor', 'attribution', 'interaction', 'reviewRound', ...DROP]);
  if (raw.fileId !== file.id || (raw.path !== undefined && raw.path !== file.path) || !['critical', 'high', 'medium', 'low'].includes(raw.severity)) fail();
  for (const key of ['title', 'evidence', 'trigger', 'impact', 'suggestion']) if (!text(raw[key])) fail();
  const a = raw.anchor;
  if (!object(a) || !['line', 'property', 'file'].includes(a.kind)) fail();
  if (file.reviewMode === 'project' && (a.side === 'old' || a.kind === 'property')) fail();
  let anchor;
  if (a.kind === 'line') {
    exact(a, ['kind', 'side', 'start', 'end', 'snippet']);
    const side = a.side === 'old' ? file.left : a.side === 'new' ? file.right : null;
    if (!side || typeof side.text !== 'string' || !Number.isSafeInteger(a.start) || !Number.isSafeInteger(a.end) || a.start < 1 || a.end < a.start || !text(a.snippet)) fail();
    const lines = side.text.replaceAll('\r\n', '\n').split('\n');
    if (a.end > lines.length || lines.slice(a.start - 1, a.end).join('\n') !== a.snippet.replaceAll('\r\n', '\n')) fail();
    anchor = { kind: 'line', side: a.side, start: a.start, end: a.end, snippet: a.snippet };
  } else if (a.kind === 'property') {
    exact(a, ['kind', 'name']);
    if (!file.properties?.some(p => p.name === a.name && p.old !== p.new)) fail();
    anchor = { kind: 'property', name: a.name };
  } else { exact(a, ['kind']); anchor = { kind: 'file' }; }
  let attribution;
  if (raw.attribution !== undefined) exact(raw.attribution, ['status', 'causality', 'precision', 'notice', 'editIds', 'properties', 'beforeBehavior', 'afterBehavior', 'reason']);
  if (file.reviewMode === 'project') {
    if (raw.attribution !== undefined && (raw.attribution.status !== 'not-applicable' || raw.attribution.causality !== 'current-source-only')) fail();
    attribution = { status: 'not-applicable', causality: 'current-source-only' };
  } else {
    const value = raw.attribution?.status === 'missing' ? undefined : raw.attribution;
    if (raw.attribution?.status === 'missing' && Object.keys(raw.attribution).some(k => !['status', 'causality'].includes(k))) fail();
    attribution = validateAttribution(value, { ...file, properties: file.properties ?? [] }, changes);
    if (raw.attribution?.status !== undefined && raw.attribution.status !== attribution.status) fail();
    for (const key of ['precision', 'notice', 'causality']) if (raw.attribution?.[key] !== undefined && raw.attribution[key] !== attribution[key]) fail();
  }
  const result = { fileId: file.id, path: file.path, severity: raw.severity, anchor, attribution };
  for (const key of ['title', 'evidence', 'trigger', 'impact', 'suggestion']) result[key] = raw[key];
  const id = hash(JSON.stringify(result));
  if (raw.id !== undefined && raw.id !== id) fail();
  if (raw.interaction !== undefined) {
    if (phase !== 'file-interaction') fail();
    exact(raw.interaction, ['status', 'causality', 'editRefs']);
    const refs = raw.interaction.editRefs;
    if (!Array.isArray(refs) || refs.length < 2 || refs.length > 50) fail();
    for (const ref of refs) {
      exact(ref, ['fileId', 'editId']);
      const target = files.get(ref.fileId);
      if (!target || target.reviewMode === 'project') fail();
      const edits = changeMap(target.left.text, target.right.text);
      if (edits.precision !== 'exact' || !edits.edits.some(e => e.id === ref.editId)) fail();
    }
    if (new Set(refs.map(r => r.fileId)).size < 2 || new Set(refs.map(r => JSON.stringify([r.fileId, r.editId]))).size !== refs.length) fail();
    const primary = refs.filter(r => r.fileId === file.id).map(r => r.editId);
    if (attribution.status !== 'references-validated' || !primary.length || primary.some(id => !attribution.editIds.includes(id)) || attribution.editIds.some(id => !primary.includes(id)) || anchor.kind !== 'line' || !changes.edits.some(e => primary.includes(e.id) && e[anchor.side].count > 0 && anchor.start < e[anchor.side].start + e[anchor.side].count && anchor.end >= e[anchor.side].start)) fail();
    result.interaction = { status: 'references-validated', causality: 'unverified', editRefs: refs.map(r => ({ ...r })) };
  } else if (phase === 'file-interaction') fail();
  return { id, ...result };
}

// Returns accepted generation payloads, NOT completed review stages. In particular,
// old verification and read delivery records never authorize a new verification.
// The enclosing resume state must bind the entire snapshot and execution options.
export function prepareStageGenerations(snapshot, records, { maxBytes = LIMIT, validateGeneration } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > LIMIT || (validateGeneration !== undefined && typeof validateGeneration !== 'function') || !Array.isArray(snapshot?.files) || !Array.isArray(records) || records.length > 100000) fail();
  const safe = clone(records);
  if (Buffer.byteLength(JSON.stringify(safe)) > maxBytes) fail();
  const files = new Map(), allIds = new Set();
  for (const file of snapshot.files) {
    if (!identity(file?.id) || allIds.has(file.id)) fail();
    allIds.add(file.id);
    if (file.eligibility === 'reviewable') files.set(file.id, file);
  }
  const seen = new Set();
  const output = safe.map(record => {
    exact(record, ['key', 'fileId', 'path', 'phase', 'round', 'windowIds', 'groupId', 'generation', 'needsFreshProvenance', ...DROP]);
    const file = files.get(record.fileId);
    if (!file || (record.path !== undefined && record.path !== file.path)) fail();
    const { phase, round = 1, windowIds = [], groupId } = record;
    const key = stageKey(file.id, { phase, round, windowIds, groupId });
    if (record.key !== key || seen.has(key) || (phase === 'file-interaction' && windowIds.length)) fail();
    seen.add(key);
    exact(record.generation, ['findings', 'limitations', ...DROP]);
    const g = record.generation;
    if (!Array.isArray(g.findings) || g.findings.length > 50 || !Array.isArray(g.limitations) || g.limitations.length > MAX_STAGE_LIMITATIONS || g.limitations.some(s => !text(s))) fail();
    const changes = reviewChangeMap(file.left.text, file.right.text);
    const findings = g.findings.map(raw => {
      if (raw.reviewRound !== undefined && raw.reviewRound !== round) fail();
      return normalizeFinding(raw, file, changes, phase, files);
    });
    const generation = { findings: [...new Map(findings.map(f => [f.id, f])).values()], limitations: [...g.limitations] };
    if (windowIds.length || phase === 'window-synthesis') {
      const windows = sourceSegments(changeWindows(file, changes) ?? []);
      const selected = windows.filter(w => windowIds.includes(w.id));
      if (!windowIds.length || selected.length !== windowIds.length) fail();
      validateWindowFindings(generation.findings, selected, phase === 'window-synthesis');
    }
    const normalized = { key, fileId: file.id, path: file.path, phase, round, windowIds: [...windowIds].sort(), ...(groupId !== undefined ? { groupId } : {}), generation, needsFreshProvenance: phase !== 'primary' };
    const checked = validateGeneration?.(clone(generation), file, clone(normalized));
    if (checked === false || checked?.then) fail();
    return normalized;
  });
  if (Buffer.byteLength(JSON.stringify(output)) > maxBytes) fail();
  return output;
}
