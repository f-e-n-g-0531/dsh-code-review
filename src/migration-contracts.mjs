import { changeMap } from './change-map.mjs';
import { createRetrievalScope } from './retrieval-scope.mjs';
import { inferImportRelations } from './import-relations.mjs';
import { inferCppRelations } from './cpp-relations.mjs';
import { buildReviewGroups } from './review-groups.mjs';
import { cppMigrationBindings } from './cpp-migration-bindings.mjs';

const NOTICE = 'Conservative syntax navigation only; not semantic migration, call reachability, authorization, read coverage or causality proof.';
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// Deliberately reject unsupported lexical constructs instead of treating comments,
// strings or overloaded/template syntax as executable bindings.
function functions(text, cpp) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 256 * 1024 || /[\x60]|\/\*|\\\r?\n/.test(text)) return [];
  const lines = text.split('\n'), found = [];
  if (cpp && lines.some(line => /^\s*#\s*(?:if|ifdef|ifndef|elif|else|endif|define|undef)\b/.test(line))) return [];
  for (let i = 0; i < lines.length; i++) {
    const match = cpp ? /^\s*(?:(?:inline|static)\s+)*(?:void|bool|int|auto)\s+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*\{\s*$/.exec(lines[i])
      : /^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*\{\s*$/.exec(lines[i]);
    if (!match) continue;
    let depth = 1, end;
    for (let j = i + 1; j < lines.length; j++) {
      // Braces inside strings/comments must not fabricate an enclosing function.
      const plain = lines[j].replace(/\/\/.*$/, '');
      if (/['"\x60\/]/.test(plain)) break;
      for (const char of plain) { if (char === '{') depth++; else if (char === '}') depth--; }
      if (depth === 0) { end = j + 1; break; }
      if (depth < 0) break;
    }
    if (end) found.push({ symbol: match[1], start: i + 1, end });
  }
  return found.filter(f => found.filter(other => other.symbol === f.symbol).length === 1).slice(0, 100);
}

/** Pure host navigation over one approved fixed snapshot. No I/O or model calls. */
export function buildMigrationContracts(snapshot, { maxContracts = 32, maxGroupFiles = 4 } = {}) {
  if (!snapshot || typeof snapshot.id !== 'string' || !Array.isArray(snapshot.files) || snapshot.files.length > 200 ||
      !Number.isSafeInteger(maxContracts) || maxContracts < 1 || maxContracts > 100 ||
      !Number.isSafeInteger(maxGroupFiles) || maxGroupFiles < 1 || maxGroupFiles > 20) throw new Error('Invalid migration contract input');
  const result = { contracts: [], groups: [], links: [], limitations: [NOTICE] };
  if (snapshot.projectScope || snapshot.files.some(f => f.reviewMode === 'project')) { result.limitations.push('Project comparison has no approved old/new migration baseline.'); return result; }
  const catalog = createRetrievalScope(snapshot).catalog(), byId = new Map(snapshot.files.map(f => [f.id, f]));
  const contexts = catalog.filter(s => !s.fileId).map(s => ({ id: '@migration-context:' + s.id, source: s,
    item: snapshot.context.find(c => c.path === s.path) }));
  if (contexts.some(c => byId.has(c.id))) throw new Error('Migration context identity collision');
  const contextIds = new Map(contexts.map(c => [c.id, c]));
  const maps = new Map(snapshot.files.filter(f => f.eligibility === 'reviewable').map(f => [f.id, changeMap(f.left.text, f.right.text)]));
  const source = (id, side) => contextIds.get(id)?.source ?? catalog.find(s => s.fileId === id && s.side === side);
  const graph = { old: [], new: [] }, definitions = new Map();
  const unresolved = new Set();
  for (const side of ['old', 'new']) {
    // Distinct path indices: an old import must never resolve using the new path.
    const entries = snapshot.files.map(f => ({ ...f, path: side === 'old' ? f.oldPath ?? f.path : f.path, oldPath: undefined,
      left: { text: '' }, right: { text: (side === 'old' ? f.left : f.right)?.text ?? '' } }));
    const sideContexts = contexts.filter(c => side === 'old' ? c.source.side === 'context-old' : c.source.side === 'context');
    if (entries.length + sideContexts.length <= 200) for (const c of sideContexts) entries.push({ id: c.id, path: c.source.path,
      eligibility: 'reviewable', left: { text: '' }, right: { text: side === 'old' ? c.item.oldText : c.item.text } });
    else unresolved.add('Context caller navigation exceeds relation budget; selected-file chains only.');
    const paths = new Map();
    for (const f of entries) { const row = paths.get(f.path) ?? []; row.push(f); paths.set(f.path, row); }
    const unique = entries.map(f => ({ ...f, eligibility: paths.get(f.path).length > 1 ? 'blocked' : f.eligibility }));
    // Duplicate paths cannot be passed to the relation helpers; retain a blocked competitor.
    const indexed = [...paths.values()].map(rows => rows.length === 1 ? unique.find(f => f.id === rows[0].id) : { ...rows[0], eligibility: 'blocked' });
    for (const f of unique.filter(f => f.eligibility === 'reviewable')) {
      const cpp = /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/.test(f.path);
      definitions.set(side + ':' + f.id, functions(f.right.text, cpp));
    }
    const classNavigation = cppMigrationBindings(indexed.map(f => ({ id: f.id, path: f.path, eligibility: f.eligibility,
      text: f.right.text, source: source(f.id, side) ?? { id: 'unavailable', side } })));
    for (const def of classNavigation.definitions) definitions.get(side + ':' + def.fileId)?.push(def);
    graph[side].push(...classNavigation.bindings);
    for (const limitation of classNavigation.limitations) unresolved.add(limitation);
    const imports = inferImportRelations(indexed).filter(e => e.side === 'new' && e.bindingHints?.length);
    for (const edge of imports) for (const binding of edge.bindingHints) {
      if (binding.declarationKind !== 'function') continue;
      graph[side].push({ from: edge.from, to: edge.to, importLine: binding.importLine, callLine: binding.callLine, symbol: binding.imported, declarationLine: binding.declarationLine });
    }
    const cppIncludes = inferCppRelations(indexed).filter(e => e.side === 'new' && e.specifier);
    for (const f of indexed.filter(f => f.eligibility === 'reviewable' && /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/.test(f.path))) {
      const defs = definitions.get(side + ':' + f.id) ?? [];
      if (!defs.length) continue;
      const lines = f.right.text.split('\n');
      for (const [i, line] of lines.entries()) {
        const call = /^\s*([A-Za-z_]\w*)\s*\([^;"'{}\/]*\)\s*;\s*$/.exec(line);
        if (!call || defs.some(d => d.symbol === call[1]) || !defs.some(d => i + 1 > d.start && i + 1 < d.end)) continue;
        // A parameter/local alias/using declaration can shadow the included name.
        // Keep only direct calls as its other token occurrences, never guess scope.
        const token = new RegExp('(^|[^A-Za-z0-9_])' + call[1] + '(?=[^A-Za-z0-9_]|$)');
        if (lines.some(line => token.test(line) && !/^\s*#\s*include\b/.test(line) &&
          !new RegExp('^\\s*' + call[1] + '\\s*\\([^;\"\'{}\\/]*\\)\\s*;\\s*$').test(line))) continue;
        const targets = cppIncludes.filter(e => e.from === f.id).flatMap(e => (definitions.get(side + ':' + e.to) ?? [])
          .filter(d => d.symbol === call[1]).map(d => ({ edge: e, def: d })));
        if (targets.length !== 1) { unresolved.add('Unresolved C++ direct call identity at ' + f.path + ':L' + (i + 1) + ' (' + side + ').'); continue; }
        const { edge, def } = targets[0];
        graph[side].push({ from: f.id, to: edge.to, importLine: edge.line, callLine: i + 1, symbol: def.symbol, declarationLine: def.start });
      }
    }
  }
  const role = (id, side, def) => {
    const file = byId.get(id), map = maps.get(id), src = source(id, side);
    if (!file || !src || map?.precision !== 'exact' || !def) return undefined;
    const edits = map.edits.filter(e => e[side].count > 0 && e[side].start <= def.end && e[side].start + e[side].count - 1 >= def.start);
    if (!edits.length || edits.length > 50) return undefined;
    return { fileId: id, sourceId: src.id, side, path: side === 'old' ? file.oldPath ?? file.path : file.path,
      sourcePath: src.path, symbol: def.symbol, line: Math.max(def.start, edits[0][side].start), declarationLine: def.start,
      editId: edits[0].id, editIds: edits.map(e => e.id) };
  };
  const caller = (edge, side) => {
    const src = source(edge.from, side), file = byId.get(edge.from), map = maps.get(edge.from);
    return { ...(file ? { fileId: edge.from } : {}), sourceId: src.id, side: src.side, sourcePath: src.path,
      path: file ? side === 'old' ? file.oldPath ?? file.path : file.path : src.path,
      line: edge.callLine, callLine: edge.callLine, importLine: edge.importLine, targetFileId: edge.to, targetSymbol: edge.symbol,
      editIds: map?.precision === 'exact' ? map.edits.filter(e => e[side].count > 0 && edge.callLine >= e[side].start && edge.callLine < e[side].start + e[side].count).map(e => e.id) : [] };
  };
  for (const side of ['old', 'new']) if (graph[side].length > 2000) {
    graph[side] = graph[side].slice(0, 2000);
    unresolved.add('Migration call navigation limit reached; remaining bindings unresolved.');
  }
  const seen = new Set();
  for (const bridge of graph.new) {
    const enclosing = (definitions.get('new:' + bridge.from) ?? []).filter(d => bridge.callLine > d.start && bridge.callLine < d.end);
    if (enclosing.length !== 1) continue;
    // A new entry calls the existing public entry, or the old entry now delegates
    // to a new entry. Neither direction proves where a guard moved.
    for (const [oldId, newId, newDef, publicSymbol] of [[bridge.to, bridge.from, enclosing[0], bridge.symbol],
      [bridge.from, bridge.to, (definitions.get('new:' + bridge.to) ?? []).find(d => d.start === bridge.declarationLine), enclosing[0].symbol]]) {
      const oldCalls = graph.old.filter(e => e.to === oldId && e.symbol === publicSymbol && e.from !== newId);
      for (const oldCall of oldCalls) {
        const oldDef = (definitions.get('old:' + oldId) ?? []).find(d => d.start === oldCall.declarationLine);
        const oldRole = role(oldId, 'old', oldDef), newRole = role(newId, 'new', newDef);
        if (!oldRole || !newRole || oldId === newId) continue;
        const key = JSON.stringify([oldId, oldRole.symbol, newId, newRole.symbol]);
        if (seen.has(key)) continue;
        seen.add(key);
        if (result.contracts.length >= maxContracts) { unresolved.add('Migration contract limit reached; additional chains remain unresolved.'); continue; }
        const oldCallerPath = source(oldCall.from, 'old')?.path;
        const newCalls = graph.new.filter(e => e.to === oldId && e.symbol === publicSymbol && (e.from === oldCall.from ||
          contextIds.has(e.from) && contextIds.has(oldCall.from) && source(e.from, 'new')?.path === oldCallerPath));
        const callers = [caller(oldCall, 'old'), ...newCalls.slice(0, 10).map(e => caller(e, 'new')), caller(bridge, 'new')];
        const pending = newCalls.length ? [] : ['Old caller has no independently resolved new-side binding.'];
        result.contracts.push({ id: 'mc' + (result.contracts.length + 1), snapshotId: snapshot.id, candidateFileIds: [oldId, newId],
          old: [oldRole], new: [newRole], callers, sourceIds: [...new Set([oldRole.sourceId, newRole.sourceId, ...callers.map(c => c.sourceId)])],
          status: 'navigation-only', causality: 'unverified', unresolved: pending,
          navigationBindings: [...new Map([...(oldDef.navigation ? [oldDef.navigation] : []),
            ...(newDef.navigation ? [newDef.navigation] : []), ...(oldCall.navigationBindings ?? []),
            ...newCalls.flatMap(e => e.navigationBindings ?? []), ...(bridge.navigationBindings ?? [])]
            .map(row => [JSON.stringify(row), row])).values()] });
      }
    }
  }
  for (const contract of result.contracts) contract.sourceIds = [...new Set([...contract.sourceIds, ...contract.navigationBindings.map(row => row.sourceId)])];
  const edges = result.contracts.flatMap(c => [{ from: c.old[0].fileId, to: c.new[0].fileId, reason: 'migration-contract:' + c.id },
    ...c.callers.filter(row => row.fileId && row.fileId !== row.targetFileId).map(row => ({ from: row.fileId, to: row.targetFileId, reason: 'migration-caller:' + c.id }))]);
  const involved = new Set(edges.flatMap(e => [e.from, e.to]));
  const grouped = buildReviewGroups(snapshot.files.filter(f => involved.has(f.id)), edges, { maxFiles: maxGroupFiles });
  result.groups = grouped.groups; result.links = grouped.links;
  result.limitations.push(...[...unresolved].sort(cmp).slice(0, 100));
  if (!result.contracts.length) result.limitations.push('No complete, unambiguous, changed old-entry/new-entry/caller syntax chain resolved.');
  return result;
}
