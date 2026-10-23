import { retrievalRequest } from './retrieval-loop.mjs';
import { modelWireBudget } from './model-wire-budget.mjs';

const MAX_READS = 4, MAX_LINES = 40;
// Optional navigation must leave room for normal retrieval and exact evidence
// validation: four reader calls plus 16KiB output. This is conservative headroom,
// not a reservation or a guarantee that arbitrary later requests will fit.
const RESERVE_CALLS = 4, RESERVE_BYTES = 16 * 1024;
const optionalError = () => Object.assign(new Error('Optional primary seed capacity exceeded'), { code: 'PRIMARY_SEED_CAPACITY' });
const line = value => Number.isSafeInteger(value) && value > 0;
const array = value => Array.isArray(value) ? value : [];

// Internal host-only reads over an already approved snapshot, never a public
// retrieval/authorization interface. Hints select coordinates, not evidence text.
export function primarySeeds(scope, request, { maxInputBytes = 96 * 1024, onRetrieved, signal = request?.signal } = {}) {
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1 || (onRetrieved !== undefined && typeof onRetrieved !== 'function') || (signal !== undefined && !(signal instanceof AbortSignal)) || (request?.signal !== undefined && !(request.signal instanceof AbortSignal))) throw new Error('Invalid primary seed options');
  const checkSignal = () => { request?.signal?.throwIfAborted(); signal?.throwIfAborted(); };
  checkSignal();
  if (typeof request?.input !== 'string' || typeof request.instructions !== 'string') throw new Error('Invalid primary seed request');
  const payload = JSON.parse(request.input);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid primary seed payload');
  if (payload.sourceMode?.includes('synthesis') || request.reviewPhase?.includes('synthesis') || !payload.file?.path) return [];
  // Optional work cannot safely roll back consumption on custom legacy readers.
  if (typeof scope?.transaction !== 'function' || typeof scope.preflight !== 'function' || typeof scope.budget !== 'function') return [];
  const catalog = scope.catalog();
  const excluded = new Set([payload.file.path, ...array(payload.relatedFiles).map(file => file.path)]);
  const provided = new Set();
  for (const context of array(payload.context)) {
    if (typeof context.text === 'string') provided.add(JSON.stringify([context.path, 'context']));
    if (typeof context.oldText === 'string') provided.add(JSON.stringify([context.path, 'context-old']));
  }
  const hints = [];
  const add = (path, side, coordinate) => {
    if (!line(coordinate) || excluded.has(path) || provided.has(JSON.stringify([path, side]))) return;
    const sources = catalog.filter(source => source.path === path && source.side === side);
    if (sources.length !== 1 || !line(sources[0].lineCount) || coordinate > sources[0].lineCount) return;
    hints.push({ source: sources[0], coordinate });
  };
  for (const relation of array(payload.contextRelations)) {
    if (!relation || typeof relation !== 'object') continue;
    const historic = relation.contextVersion !== undefined && relation.contextVersion !== 'approved-current-not-historical';
    if (historic && (typeof relation.contextVersion !== 'string' || !relation.contextVersion || !['old', 'new'].includes(relation.contextSide))) continue;
    if (!historic && relation.contextSide !== undefined) continue;
    const side = historic && relation.contextSide === 'old' ? 'context-old' : 'context';
    if (relation.fromPath === payload.file.path) {
      if (historic && relation.side !== relation.contextSide) continue;
      for (const hint of [...array(relation.definitionHints), ...array(relation.bindingHints)]) add(relation.toPath, side, hint?.declarationLine);
    } else if (relation.toPath === payload.file.path) {
      if (!['context', 'context-old'].includes(relation.side) || relation.side !== side) continue;
      add(relation.fromPath, side, relation.line);
      for (const hint of array(relation.callSites)) add(relation.fromPath, side, hint?.line);
      for (const hint of array(relation.bindingHints)) { add(relation.fromPath, side, hint?.importLine); add(relation.fromPath, side, hint?.callLine); }
    }
  }
  for (const caller of array(payload.callerBindings)) {
    if (!caller || typeof caller !== 'object') continue;
    const historic = caller.side !== undefined || caller.revision !== undefined || caller.contextSide !== undefined;
    if (historic && (!['old', 'new'].includes(caller.side) || typeof caller.revision !== 'string' || !caller.revision || caller.targetRevision !== caller.revision || caller.contextSide !== (caller.side === 'old' ? 'context-old' : 'context'))) continue;
    const side = historic ? caller.contextSide : 'context';
    for (const hint of array(caller.bindings)) { add(caller.fromPath, side, hint?.importLine); add(caller.fromPath, side, hint?.callLine); }
  }
  const seeds = [], attempted = new Set();
  for (const { source, coordinate } of hints) {
    checkSignal();
    if (attempted.size >= MAX_READS) break;
    if (seeds.some(item => item.request.id === source.id && item.result.start <= coordinate && coordinate < item.result.start + item.result.count)) continue;
    const budget = scope.budget();
    if (budget.remainingOutputBytes <= RESERVE_BYTES) break;
    const operation = { kind: 'read', id: source.id, start: Math.max(1, coordinate - 4), count: MAX_LINES };
    const key = JSON.stringify(operation);
    if (attempted.has(key)) continue;
    attempted.add(key);
    let item;
    try {
      // A cached raw delivery costs no new materialization call, but still uses
      // output bytes and must pass the exact operation's approved preflight.
      const cached = budget.reusableResults === true && scope.preflight([operation])?.calls === 0 && scope.canServe?.([operation]) === true;
      if (!cached && budget.remainingCalls <= RESERVE_CALLS) continue;
      item = scope.transaction(() => {
        checkSignal();
        scope.preflight([operation]);
        const result = scope.read(operation);
        checkSignal();
        const next = retrievalRequest(request, scope, [...seeds, { request: operation, result }]);
        const remaining = scope.budget();
        if (result.start + result.count <= coordinate || (!cached && remaining.remainingCalls < RESERVE_CALLS) || remaining.remainingOutputBytes < RESERVE_BYTES || (request.nativeOutputTools === true ? !modelWireBudget(next, maxInputBytes).fits : Buffer.byteLength(next.input) + Buffer.byteLength(next.instructions) > maxInputBytes)) throw optionalError();
        return { request: operation, result };
      });
    } catch (error) {
      checkSignal();
      if (['PRIMARY_SEED_CAPACITY', 'READER_CALL_BUDGET_EXCEEDED', 'READER_OUTPUT_BUDGET_EXCEEDED'].includes(error?.code)) continue;
      throw error;
    }
    seeds.push(item);
    // Never audit a rolled-back result. When retrievalLoop consumes these seeds,
    // let that loop publish its audit instead (do not supply this callback twice).
    onRetrieved?.([{ kind: 'read', snapshotId: item.result.snapshotId, stage: 'retrieved-locally', sourceId: item.result.sourceId, hash: item.result.hash, start: item.result.start, count: item.result.count, resultBytes: Buffer.byteLength(JSON.stringify(item.result)) }]);
  }
  checkSignal();
  return seeds;
}
