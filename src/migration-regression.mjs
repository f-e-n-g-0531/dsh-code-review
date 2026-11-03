import { isDeepStrictEqual, types } from 'node:util';
import { changeMap } from './change-map.mjs';
import { contextSources } from './context-identity.mjs';
import { hash } from './content.mjs';
import { buildMigrationContracts } from './migration-contracts.mjs';

const contexts = new WeakSet();
const positive = value => Number.isSafeInteger(value) && value > 0;
const overlap = (ref, range) => range?.count > 0 && ref.start < range.start + range.count && range.start < ref.start + ref.count;
const fail = () => { throw new Error('Invalid approved migration regression contract'); };
const freeze = value => { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; };

// Copy only inert own data. structuredClone/JSON.stringify would invoke getters
// before validation; custom prototypes, proxies and toJSON hooks are not input data.
function inertData(value, state = { remaining: 100000 }, depth = 0) {
  if (--state.remaining < 0 || depth > 32) fail();
  if (value === null || value === undefined || ['string', 'boolean', 'number'].includes(typeof value)) return value;
  if (typeof value !== 'object' || types.isProxy(value)) fail();
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array)) fail();
  const copy = array ? [] : {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || ['__proto__', 'constructor', 'toJSON'].includes(key)) fail();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!Object.hasOwn(descriptor, 'value')) fail();
    if (array && key === 'length') continue;
    if (!descriptor.enumerable) fail();
    Object.defineProperty(copy, key, { value: inertData(descriptor.value, state, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  if (array && copy.length !== value.length) fail();
  return copy;
}

// The original manually approved protocol has no host navigation coordinates.
// Do not infer host origin solely from kind: that tag is removable input data.
function legacyContract(contract) {
  const only = (value, keys) => value && Object.keys(value).every(key => keys.includes(key));
  const roleKeys = ['sourceId', 'fileId', 'path', 'side', 'line', 'symbol', 'editIds'];
  return only(contract, ['id', 'snapshotId', 'status', 'causality', 'candidateFileIds', 'old', 'new', 'callers']) &&
    [...contract.old, ...contract.new].every(role => only(role, roleKeys)) &&
    contract.callers.every(role => only(role, [...roleKeys, 'importLine', 'targetFileId', 'targetSymbol']));
}

// Compile host navigation against the exact approved snapshot. No model-provided
// contract object or copied input metadata can replace this invocation capability.
export function prepareMigrationRegression(snapshot, scope, contracts, candidates) {
  contracts = inertData(contracts);
  candidates = inertData(candidates);
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
    if (value.startLine !== undefined && (!positive(value.startLine) || !positive(value.endLine) || value.startLine > line || value.endLine < line || value.endLine > source.lineCount)) fail();
    return { sourceId: source.id, side: source.side, path: value.path, sourcePath: source.path, ...(source.fileId ? { fileId: source.fileId } : {}), line, ...(value.startLine !== undefined ? { startLine: value.startLine, endLine: value.endLine } : {}), hash: hash(body), edits };
  };
  const ids = new Set(), compiled = [];
  const approvedContracts = contracts.length ? buildMigrationContracts(snapshot, { maxContracts: 100 }).contracts : [];
  for (const contract of contracts) {
    if (!contract || typeof contract.id !== 'string' || !contract.id || contract.id.length > 200 || ids.has(contract.id) || contract.snapshotId !== snapshot.id || contract.status !== 'navigation-only' || contract.causality !== 'unverified' || !Array.isArray(contract.callers) || contract.callers.length > 32) fail();
    ids.add(contract.id);
    if (!Array.isArray(contract.old) || contract.old.length !== 1 || !Array.isArray(contract.new) || contract.new.length !== 1 || !Array.isArray(contract.candidateFileIds)) fail();
    const oldValue = contract.old[0], newValue = contract.new[0];
    // Rebuild all host shapes (ordinary navigation included), comparing the complete
    // identity, not just roles. Renaming an ID or deleting every origin marker must
    // not turn an independently known host route into the legacy manual protocol.
    const approved = approvedContracts.find(item => isDeepStrictEqual(item, contract));
    const knownRoute = approvedContracts.some(item => item.id === contract.id ||
      item.old[0].sourceId === oldValue?.sourceId && item.new[0].sourceId === newValue?.sourceId);
    if (!approved && (knownRoute || !legacyContract(contract))) fail();
    const old = role(oldValue, 'old'), current = role(newValue, 'new');
    const exportRoute = contract.kind === 'deleted-export-route';
    const delegation = contract.kind === 'old-delegation' || exportRoute;
    if (contract.kind !== undefined && !delegation) fail();
    let baseline = [];
    if (delegation) {
      // Only a complete independently rebuilt host contract can carry these roles.
      if (!approved || (!exportRoute && old.fileId !== current.fileId) || !Array.isArray(contract.baseline) || contract.baseline.length !== 1) fail();
      baseline = contract.baseline.map(value => role(value));
      if (!['old', 'context-old'].includes(baseline[0].side)) fail();
    }
    if (!old.fileId || !current.fileId || !delegation && old.fileId === current.fileId || old.sourceId === current.sourceId || !old.edits.length || !current.edits.length) fail();
    const callers = contract.callers.map(caller => {
      const result = role(caller);
      if (!['old', 'new', 'context-old', 'context'].includes(result.side) || !delegation && caller.targetFileId !== oldValue.fileId && caller.targetFileId !== newValue.fileId) fail();
      return result;
    });
    // The navigation chain has an explicit old-entry caller; a new-role source
    // alone cannot manufacture a migration relation between arbitrary files.
    if (!contract.callers.some(caller => (delegation ? caller.sourceId === old.sourceId : caller.targetFileId === oldValue.fileId) && ['old', 'context-old'].includes(caller.side))) fail();
    const fileIds = [...new Set([old.fileId, current.fileId].filter(Boolean))];
    if (new Set(contract.candidateFileIds).size !== contract.candidateFileIds.length || contract.candidateFileIds.length !== fileIds.length || contract.candidateFileIds.some(id => !fileIds.includes(id))) fail();
    compiled.push({ id: contract.id, snapshotId: snapshot.id, ...(delegation ? { kind: contract.kind, baseline } : {}), old, new: current, callers, candidateFileIds: fileIds });
  }
  const context = freeze({ snapshotId: snapshot.id, contracts: compiled, candidates: structuredClone(candidates) });
  contexts.add(context);
  return context;
}

export function migrationRegressionMetadata(context) {
  if (!contexts.has(context)) fail();
  return context.contracts.map(contract => ({ ...structuredClone(contract), old: [structuredClone(contract.old)], new: [structuredClone(contract.new)], status: 'navigation-only', causality: 'unverified' }));
}

// Host-only read plans. The capability, candidate attribution and coordinates all
// come from this compiler invocation, never from a later candidate/contract copy.
export function migrationVerificationPlans(context) {
  if (!contexts.has(context)) fail();
  return context.candidates.map((candidate, index) => {
    const candidateId = 'c' + (index + 1);
    const matches = context.contracts.filter(contract => contract.candidateFileIds.includes(candidate.fileId) &&
      candidate.attribution?.status === 'references-validated' && Array.isArray(candidate.attribution.editIds) &&
      [contract.old, contract.new].some(role => role.fileId === candidate.fileId && role.edits.some(edit =>
        candidate.attribution.editIds.includes(edit.editId) && candidate.anchor?.kind === 'line' &&
        candidate.anchor.side === (role.side === 'old' ? 'old' : 'new') &&
        positive(candidate.anchor.start) && positive(candidate.anchor.end) && candidate.anchor.end >= candidate.anchor.start &&
        overlap({ start: candidate.anchor.start, count: candidate.anchor.end - candidate.anchor.start + 1 }, edit.range))));
    const contract = matches[0];
    if (!contract) return { candidateId, candidate, reason: 'NO_MATCHING_CONTRACT' };
    const roles = [contract.old, contract.new, ...(contract.baseline ?? [])];
    const identity = { candidateId, candidate, contractId: contract.id, kind: contract.kind ?? 'migration', rolesCount: roles.length };
    if (roles.some(role => !positive(role.startLine) || !positive(role.endLine) || role.endLine < role.startLine)) return { ...identity, reason: 'INCOMPLETE_ROLE_RANGE' };
    const requests = new Map();
    for (const role of roles) {
      for (let start = role.startLine; start <= role.endLine; start += 200) {
        const request = { kind: 'read', id: role.sourceId, start, count: Math.min(200, role.endLine - start + 1) };
        requests.set(JSON.stringify(request), request);
        if (requests.size > 8) return { ...identity, reason: 'EVIDENCE_LIMIT' };
      }
    }
    return { ...identity, requests: [...requests.values()] };
  });
}

export function validateMigrationRegression(value, evidence, fileId, context, candidateId) {
  if (!contexts.has(context) || typeof value.migrationContractId !== 'string') fail();
  const contract = context.contracts.find(contract => contract.id === value.migrationContractId && contract.candidateFileIds.includes(fileId));
  const candidate = context.candidates.find((candidate, index) => candidate.fileId === fileId && (!candidateId || candidateId === 'c' + (index + 1)));
  if (!contract || !candidate || candidate.attribution?.status !== 'references-validated' || !Array.isArray(candidate.attribution.editIds)) fail();
  const ownRoles = [contract.old, contract.new].filter(role => role.fileId === fileId);
  if (!ownRoles.some(role => role.edits.some(edit => candidate.attribution.editIds.includes(edit.editId) && candidate.anchor?.kind === 'line' && candidate.anchor.side === (role.side === 'old' ? 'old' : 'new') && overlap({ start: candidate.anchor.start, count: candidate.anchor.end - candidate.anchor.start + 1 }, edit.range)))) fail();
  if (contract.kind === 'deleted-export-route' && value.classification !== 'uncertain') throw new Error('Deleted export candidate navigation permits uncertain classification only');
  let actualEdit = false;
  for (const [field, edge, sides] of [['oldEvidence', contract.old, ['old', 'context-old']], ['newEvidence', contract.new, ['new', 'context']]]) {
    const indices = value[field];
    if (!Array.isArray(indices) || indices.length > 8 || new Set(indices).size !== indices.length) fail();
    let entry = false;
    for (const index of indices) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= evidence.length) fail();
      const ref = evidence[index];
      const binding = [edge, ...(contract.baseline ?? []), ...contract.callers.filter(role => sides.includes(role.side))].find(role => role.sourceId === ref.sourceId && sides.includes(role.side));
      if (!binding || ref.status !== 'references-validated' || ref.snapshotId !== context.snapshotId || ref.hash !== binding.hash || !positive(ref.start) || !positive(ref.count) || binding !== edge && !(binding.startLine !== undefined ? ref.start <= binding.endLine && binding.startLine < ref.start + ref.count : ref.start <= binding.line && binding.line < ref.start + ref.count)) fail();
      if (binding === edge && ref.start <= edge.line && edge.line < ref.start + ref.count) {
        entry = true;
        if (edge.edits.some(edit => overlap(ref, edit.range))) actualEdit = true;
      }
    }
    if (value.classification !== 'uncertain' && !entry) throw new Error('Migration comparison requires both explicit entry roles');
  }
  if (value.classification !== 'uncertain' && contract.kind === 'old-delegation') {
    for (const required of [contract.old, contract.new, ...contract.baseline]) {
      const indices = ['old', 'context-old'].includes(required.side) ? value.oldEvidence : value.newEvidence;
      const ranges = indices.map(index => evidence[index]).filter(ref => ref.sourceId === required.sourceId).sort((a, b) => a.start - b.start);
      let through = required.startLine;
      for (const ref of ranges) { if (ref.start > through) break; through = Math.max(through, ref.start + ref.count); }
      if (through <= required.endLine) throw new Error('Migration delegation comparison requires complete entry and baseline evidence');
    }
  }
  if (value.classification !== 'uncertain' && !actualEdit) throw new Error('Migration comparison requires actual changed-role evidence');
  return { ...value, oldEvidence: [...value.oldEvidence], newEvidence: [...value.newEvidence], migrationContractId: contract.id, migrationSnapshotId: context.snapshotId, status: 'comparison-references-validated', causality: 'unverified' };
}
