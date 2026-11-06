import { approvedModelComparisonRanges } from './model-comparison-context.mjs';
import { createHash } from 'node:crypto';
import { types } from 'node:util';

const FAILURE_KINDS = new Set(['structural-schema', 'evidence-identity', 'role-side', 'role-completeness', 'anchor-edit', 'context-token']);
const fail = (reason = 'structural-schema') => {
  const comparisonFailure = FAILURE_KINDS.has(reason) ? reason : 'structural-schema';
  throw Object.assign(new Error('Invalid model-assessed comparison references'), { code: 'INVALID_MODEL_COMPARISON', comparisonFailure });
};
const positive = n => Number.isSafeInteger(n) && n > 0;
const words = value => typeof value === 'string' && value.trim() && value.length <= 8000;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function copy(value, depth = 0, budget = { nodes: 200000 }) {
  if (--budget.nodes < 0 || depth > 32) fail();
  if (value === null || value === undefined || ['string', 'boolean', 'number'].includes(typeof value)) return value;
  if (typeof value !== 'object' || types.isProxy(value)) fail();
  const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
  if (proto !== (array ? Array.prototype : Object.prototype) && !(proto === null && !array)) fail();
  const result = array ? [] : {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || ['__proto__', 'constructor', 'toJSON'].includes(key)) fail();
    if (array && key === 'length') continue;
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d.enumerable || !Object.hasOwn(d, 'value')) fail();
    Object.defineProperty(result, key, { value: copy(d.value, depth + 1, budget), enumerable: true, writable: true, configurable: true });
  }
  if (array && (result.length !== value.length || Object.keys(result).length !== result.length)) fail();
  return result;
}
function exact(value, allowed, required = allowed, reason = 'structural-schema') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(value, k))) fail(reason);
}
const oldSide = side => ['old', 'context-old'].includes(side);
const newSide = side => ['new', 'context'].includes(side);
const physicalLines = text => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

// Offline, host-only call site: evidence MUST already be validated against the
// current approved reader and invocation receipt table. Status strings alone are
// not a public capability. This validator never reads or authorizes new sources.
// changes is the host's exact changeMap for candidate.fileId, never model input.
export function validateModelComparisonAssessment(value, evidence, catalog, fileId, options = {}) {
  if (!options || typeof options !== 'object' || types.isProxy(options)) fail();
  const descriptor = Object.getOwnPropertyDescriptor(options, 'context');
  if (descriptor && (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable)) fail('context-token');
  const context = descriptor?.value;
  const plainOptions = Object.fromEntries(Reflect.ownKeys(options).filter(key => key !== 'context').map(key => {
    const d = Object.getOwnPropertyDescriptor(options, key);
    if (typeof key !== 'string' || !Object.hasOwn(d, 'value') || !d.enumerable) fail();
    return [key, d.value];
  }));
  options = copy(plainOptions);
  exact(options, ['enableModelComparison', 'snapshotId', 'candidate', 'changes']);
  if (options.enableModelComparison !== true || !words(options.snapshotId) || !words(fileId)) fail();
  value = copy(value); evidence = copy(evidence); catalog = copy(catalog);
  exact(value, ['classification', 'reason', 'comparison']);
  if (!['introduced', 'preexisting', 'uncertain'].includes(value.classification) || !words(value.reason)) fail();
  exact(value.comparison, ['kind', 'roles', 'relationshipReason']);
  if (value.comparison.kind !== 'model-assessed-cross-file' || !words(value.comparison.relationshipReason)) fail();
  const roleNames = ['oldEntry', 'oldDelegate', 'newEntry', 'newDelegate', 'callers'];
  exact(value.comparison.roles, roleNames, ['oldEntry', 'oldDelegate', 'newEntry', 'callers']);
  if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 8 || !Array.isArray(catalog) || catalog.length > 1000) fail();
  let approved;
  if (descriptor) {
    try { approved = approvedModelComparisonRanges(context, options.snapshotId, [...new Set(evidence.map(ref => ref.sourceId))]); }
    catch { fail('context-token'); }
  }
  const covered = [];
  const sources = new Map();
  for (const source of catalog) {
    if (!source || !words(source.id) || sources.has(source.id) || !words(source.path) || !positive(source.lineCount) && source.lineCount !== 0 || !oldSide(source.side) && !newSide(source.side)) fail('evidence-identity');
    sources.set(source.id, source);
  }
  for (const ref of evidence) {
    exact(ref, ['snapshotId', 'sourceId', 'hash', 'start', 'count', 'text', 'status', 'causality'], ['snapshotId', 'sourceId', 'hash', 'start', 'count', 'text', 'status'], 'evidence-identity');
    const source = sources.get(ref.sourceId);
    if (!source || ref.status !== 'references-validated' || ref.snapshotId !== options.snapshotId || !hash(ref.hash) || !positive(ref.start) || !positive(ref.count) || ref.count > 200 || ref.start > source.lineCount || ref.count > source.lineCount - ref.start + 1 || typeof ref.text !== 'string' || !ref.text || Buffer.byteLength(ref.text) > 65536 || physicalLines(ref.text).length !== ref.count || source.hash !== undefined && source.hash !== ref.hash) fail('evidence-identity');
  }
  if (approved) for (const ref of evidence) {
    const bound = approved.sources.find(source => source.id === ref.sourceId), current = sources.get(ref.sourceId);
    if (!bound || bound.hash !== ref.hash || bound.fileId !== current.fileId || bound.path !== current.path || bound.side !== current.side || bound.lineCount !== current.lineCount) fail('evidence-identity');
  }
  const used = new Set();
  for (const [name, indices] of Object.entries(value.comparison.roles)) {
    if (!Array.isArray(indices) || !indices.length || indices.length > 8 || new Set(indices).size !== indices.length) fail('role-completeness');
    const grouped = new Map();
    for (const index of indices) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= evidence.length) fail('role-completeness');
      used.add(index);
      const ref = evidence[index], source = sources.get(ref.sourceId);
      if (name.startsWith('old') && !oldSide(source.side) || name.startsWith('new') && !newSide(source.side)) fail('role-side');
      const group = grouped.get(ref.sourceId) ?? []; group.push(ref); grouped.set(ref.sourceId, group);
    }
    if (name !== 'callers' && grouped.size !== 1) fail('role-completeness');
    for (const [sourceId, refs] of grouped) {
      const source = sources.get(sourceId), lines = new Map();
      if (!positive(source.lineCount) || new Set(refs.map(ref => ref.hash)).size !== 1) fail('role-completeness');
      for (const ref of refs) for (const [offset, line] of physicalLines(ref.text).entries()) {
        const n = ref.start + offset;
        if (lines.has(n) && lines.get(n) !== line) fail('evidence-identity');
        lines.set(n, line);
      }
      if (lines.size === source.lineCount) {
        const body = [...lines].sort((a, b) => a[0] - b[0]).map(([, line]) => line).join('');
        if (createHash('sha256').update(body).digest('hex') !== refs[0].hash) fail('evidence-identity');
        covered.push({ name, sourceId, start: 1, end: source.lineCount });
      } else {
        const ranges = approved?.ranges.filter(range => range.sourceId === sourceId && range.hash === refs[0].hash && Number.isSafeInteger(range.start) && positive(range.count) && range.start > 0 && Array.from({ length: range.count }, (_, i) => range.start + i).every(line => lines.has(line))) ?? [];
        if (!ranges.length) fail('role-completeness');
        for (const range of ranges) covered.push({ name, sourceId, start: range.start, end: range.start + range.count - 1 });
      }
    }
  }
  // Supplemental exact references may describe contracts, counterevidence or
  // downstream effects without claiming an entry/delegate/caller role. Every
  // reference was identity-checked above; only role indices authorize comparison.
  // Do not force an unrelated document fragment into a full-function role.
  const candidate = options.candidate, changes = options.changes;
  if (!candidate || candidate.fileId !== fileId || candidate.attribution?.status !== 'references-validated' || !Array.isArray(candidate.attribution.editIds) || !candidate.attribution.editIds.length || new Set(candidate.attribution.editIds).size !== candidate.attribution.editIds.length || candidate.anchor?.kind !== 'line' || !['old', 'new'].includes(candidate.anchor.side) || !positive(candidate.anchor.start) || !positive(candidate.anchor.end) || candidate.anchor.end < candidate.anchor.start || changes?.status !== 'changed' || changes.precision !== 'exact' || !Array.isArray(changes.edits)) fail('anchor-edit');
  const matchedEdits = candidate.attribution.editIds.map(id => changes.edits.filter(edit => edit.id === id));
  if (matchedEdits.some(list => list.length !== 1)) fail('anchor-edit');
  const anchor = candidate.anchor;
  if (!matchedEdits.some(([edit]) => positive(edit[anchor.side]?.start) && positive(edit[anchor.side]?.count) && anchor.start < edit[anchor.side].start + edit[anchor.side].count && edit[anchor.side].start <= anchor.end)) fail('anchor-edit');
  const primaryRoles = Object.entries(value.comparison.roles).filter(([name]) => anchor.side === 'old' ? name.startsWith('old') : name.startsWith('new'));
  if (!primaryRoles.some(([name]) => covered.some(range => { const source = sources.get(range.sourceId); return range.name === name && source.fileId === fileId && source.side === anchor.side && range.start <= anchor.start && range.end >= anchor.end; }))) fail('anchor-edit');
  const oldEvidence = [], newEvidence = [];
  for (const index of [...used].sort((a, b) => a - b)) (oldSide(sources.get(evidence[index].sourceId).side) ? oldEvidence : newEvidence).push(index);
  return freeze({ ...value, oldEvidence, newEvidence, status: 'model-comparison-references-validated', relationshipStatus: 'model-assessed', sourceReferencesValidated: true, causality: 'unverified' });
}
