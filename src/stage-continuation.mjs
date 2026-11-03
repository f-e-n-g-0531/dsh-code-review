import { createHash } from 'node:crypto';
const KINDS = new Set(['primary', 'verification', 'synthesis', 'interaction']);
const REASONS = new Set(['READER_CALL_BUDGET_EXCEEDED', 'READER_OUTPUT_BUDGET_EXCEEDED', 'STAGE_INTERRUPTED', 'STAGE_CANCELLED', 'STAGE_TIMEOUT', 'STAGE_NO_PROGRESS', 'STAGE_ATTEMPTS_EXHAUSTED', 'STAGE_FAILED']);
const fail = code => Object.assign(new Error(code), { code });
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);

// Host metadata only: accepted generation belongs in the separate owner-bound
// checkpoint. No read results/receipts are persisted or minted by this machine.
export function createStageContinuation(snapshot, options, { completedPrimary = [], units = [], checkpoint, maxAttempts = 2 } = {}) {
  if (!snapshot || typeof snapshot.id !== 'string' || !Array.isArray(snapshot.files) || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 4 || !Array.isArray(units) || units.length > 2000) throw fail('INVALID_STAGE_CONTINUATION');
  const fileIds = new Set(snapshot.files.filter(f => f.eligibility === 'reviewable').map(f => f.id));
  if (!Array.isArray(completedPrimary) || new Set(completedPrimary).size !== completedPrimary.length || completedPrimary.some(id => !fileIds.has(id))) throw fail('INVALID_STAGE_PRIMARY');
  const primary = [...completedPrimary].sort(), states = new Map();
  for (const unit of units) {
    if (!unit || typeof unit.id !== 'string' || !unit.id || unit.id.length > 500 || states.has(unit.id) || unit.id.startsWith('primary:') || !KINDS.has(unit.kind) || !Array.isArray(unit.fileIds) || !unit.fileIds.length || new Set(unit.fileIds).size !== unit.fileIds.length || unit.fileIds.some(id => !fileIds.has(id)) || !Array.isArray(unit.dependencies ?? []) || new Set(unit.dependencies ?? []).size !== (unit.dependencies ?? []).length) throw fail('INVALID_STAGE_UNIT');
    states.set(unit.id, { id: unit.id, kind: unit.kind, fileIds: [...unit.fileIds], dependencies: [...(unit.dependencies ?? [])], status: 'pending', attempts: 0, pendingReason: null, stopped: false });
  }
  const visit = (id, visiting = new Set(), visited = new Set()) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw fail('INVALID_STAGE_DEPENDENCIES');
    visiting.add(id);
    for (const dep of states.get(id).dependencies) {
      if (typeof dep !== 'string' || dep === id) throw fail('INVALID_STAGE_DEPENDENCIES');
      if (dep.startsWith('primary:')) { if (!fileIds.has(dep.slice(8))) throw fail('INVALID_STAGE_DEPENDENCIES'); }
      else { if (!states.has(dep)) throw fail('INVALID_STAGE_DEPENDENCIES'); visit(dep, visiting, visited); }
    }
    visiting.delete(id); visited.add(id);
  };
  const visited = new Set(); for (const id of states.keys()) visit(id, new Set(), visited);
  const identityHash = digest({ snapshot, options, primary, units: [...states.values()].map(({id,kind,fileIds,dependencies})=>({id,kind,fileIds,dependencies})), maxAttempts });
  if (checkpoint !== undefined) {
    if (!checkpoint || checkpoint.schemaVersion !== 1 || checkpoint.snapshotId !== snapshot.id || checkpoint.identityHash !== identityHash || checkpoint.maxAttempts !== maxAttempts || !same(checkpoint.completedPrimary, primary) || !Array.isArray(checkpoint.units) || checkpoint.units.length !== states.size || Object.keys(checkpoint).sort().join(',') !== 'completedPrimary,identityHash,maxAttempts,schemaVersion,snapshotId,units') throw fail('STAGE_CONTINUATION_IDENTITY_MISMATCH');
    const seen = new Set();
    for (const saved of checkpoint.units) {
      const state = states.get(saved?.id);
      if (!state || seen.has(saved.id) || !same(saved.fileIds,state.fileIds) || !same(saved.dependencies,state.dependencies) || saved.kind !== state.kind || !['pending','running','completed'].includes(saved.status) || !Number.isSafeInteger(saved.attempts) || saved.attempts < 0 || saved.attempts > maxAttempts || typeof saved.stopped !== 'boolean' || saved.pendingReason !== null && !REASONS.has(saved.pendingReason) || Object.keys(saved).sort().join(',') !== 'attempts,dependencies,fileIds,id,kind,pendingReason,status,stopped' || (saved.status !== 'pending' && saved.attempts === 0)) throw fail('INVALID_STAGE_CHECKPOINT');
      seen.add(saved.id); Object.assign(state, { status: saved.status === 'running' ? 'pending' : saved.status, attempts: saved.attempts, pendingReason: saved.status === 'running' ? 'STAGE_INTERRUPTED' : saved.pendingReason, stopped: saved.stopped });
    }
  }
  const get = id => { const state=states.get(id); if (!state) throw fail('UNKNOWN_STAGE_UNIT'); return state; };
  // The completedPrimary baseline is immutable. A pending primary may run without
  // belonging to it; secondary work must name a completed primary unit explicitly
  // when relying on primary work performed by this continuation. Reserved
  // primary:<fileId> dependencies still refer only to the completed baseline.
  const dependencyCompleted = dep => dep.startsWith('primary:') ? primary.includes(dep.slice(8)) : get(dep).status === 'completed';
  const primaryCompleted = (state, fileId) => primary.includes(fileId) || state.dependencies.some(dep => {
    if (dep.startsWith('primary:')) return false;
    const prerequisite = get(dep);
    return prerequisite.kind === 'primary' && prerequisite.status === 'completed' && prerequisite.fileIds.includes(fileId);
  });
  const dependenciesReady = state => (state.kind === 'primary' || state.fileIds.every(id => primaryCompleted(state, id))) && state.dependencies.every(dependencyCompleted);
  for (const state of states.values()) {
    if (state.status === 'completed' && (!dependenciesReady(state) || state.stopped || state.pendingReason !== null)) throw fail('INVALID_STAGE_CHECKPOINT');
  }
  const copy = state => structuredClone(state);
  const api = {
    ready() { return [...states.values()].filter(s => s.status === 'pending' && !s.stopped && s.attempts < maxAttempts && dependenciesReady(s)).map(copy); },
    start(id, { signal } = {}) {
      signal?.throwIfAborted(); const state=get(id);
      if (state.status !== 'pending' || state.stopped || state.attempts >= maxAttempts || !dependenciesReady(state)) throw fail('STAGE_NOT_READY');
      state.status='running'; state.attempts++; state.pendingReason=null;
      return { id, attempt: state.attempts, kind: state.kind, fileIds: [...state.fileIds], boundary: 'stage-start', requiresFreshEvidence: true };
    },
    complete(id, attempt, { signal } = {}) {
      const state=get(id);
      if (state.status !== 'running' || state.attempts !== attempt) throw fail('STALE_STAGE_ATTEMPT');
      if (signal?.aborted) { state.status='pending'; state.pendingReason='STAGE_CANCELLED'; state.stopped=true; signal.throwIfAborted(); }
      state.status='completed'; state.pendingReason=null;
    },
    yield(id, reason = 'STAGE_NO_PROGRESS') {
      const state=get(id); if (state.status !== 'running' || !REASONS.has(reason)) throw fail('INVALID_STAGE_TRANSITION');
      state.status='pending'; state.pendingReason=state.attempts >= maxAttempts ? 'STAGE_ATTEMPTS_EXHAUSTED' : reason; state.stopped=state.attempts >= maxAttempts;
    },
    stop(id, reason = 'STAGE_NO_PROGRESS') {
      const state=get(id); if (state.status === 'completed' || !REASONS.has(reason)) throw fail('INVALID_STAGE_TRANSITION');
      state.status='pending'; state.pendingReason=reason; state.stopped=true;
    },
    checkpoint() { return { schemaVersion: 1, snapshotId: snapshot.id, identityHash, maxAttempts, completedPrimary: [...primary], units: [...states.values()].map(copy) }; },
    summary() { const values=[...states.values()]; return { units: values.length, completed: values.filter(s=>s.status==='completed').length, pending: values.filter(s=>s.status==='pending').length, running: values.filter(s=>s.status==='running').length, stopped: values.filter(s=>s.stopped).length, attempts: values.reduce((n,s)=>n+s.attempts,0) }; },
  };
  return Object.freeze(api);
}
