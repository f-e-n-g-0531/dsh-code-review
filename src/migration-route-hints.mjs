import { createHash } from 'node:crypto';
import { changeMap } from './change-map.mjs';
import { createRetrievalScope } from './retrieval-scope.mjs';
import { cppExportRouteDefinitions } from './cpp-migration-bindings.mjs';

const NOTICE = 'Lexical navigation only: not a migration contract, same-function identity, reachability, read coverage or introduced/preexisting proof. Read and compare old public gates and new state under the same trigger.';
const digest = text => createHash('sha256').update(text).digest('hex');
// Mask comments and quoted literals, preserving original line coordinates. No macro expansion.
function mask(text) {
  if (/R"/.test(text) || /\\\r?\n/.test(text)) return undefined;
  let out = '', state = 'code';
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (state === 'line') { if (c === '\n') { out += c; state = 'code'; } else out += ' '; continue; }
    if (state === 'block') { if (c === '*' && n === '/') { out += '  '; i++; state = 'code'; } else out += c === '\n' ? c : ' '; continue; }
    if (state === '"' || state === "'") { if (c === '\\') { out += ' '; if (n !== undefined) { out += n === '\n' ? n : ' '; i++; } } else { out += c === '\n' ? c : ' '; if (c === state) state = 'code'; } continue; }
    if (c === '/' && n === '/') { out += '  '; i++; state = 'line'; }
    else if (c === '/' && n === '*') { out += '  '; i++; state = 'block'; }
    else if (c === '"' || c === "'") { state = c; out += ' '; }
    else out += c;
  }
  if (state === 'block' || state === '"' || state === "'") return undefined;
  return out.split('\n').map(line => /^\s*#/.test(line) ? '' : line).join('\n');
}
function definitions(text, clean) {
  const lines = clean.split('\n'), found = [];
  // Reuse exact legacy export parser when it supports the complete file.
  for (const def of cppExportRouteDefinitions(text)) found.push({ symbol: def.symbol.split('::').at(-1), line: def.start, end: def.end, preciseSyntax: true });
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:[A-Za-z_]\w*(?:\s*[*&])?\s+)+((?:[A-Za-z_]\w*::)*[A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:const\s*)?(\{)?\s*$/.exec(lines[i]);
    if (!m || /^(if|for|while|switch|catch)$/.test(m[1])) continue;
    const brace = m[2] ? i : i + 1;
    if (!m[2] && !/^\s*\{\s*$/.test(lines[brace] ?? '')) continue;
    let depth = 0, end;
    for (let j = brace; j < lines.length; j++) {
      for (const c of lines[j]) { if (c === '{') depth++; else if (c === '}') depth--; }
      if (depth === 0) { end = j + 1; break; }
      if (depth < 0) break;
    }
    if (end && !found.some(d => d.line === i + 1)) found.push({ symbol: m[1].split('::').at(-1), line: i + 1, end, preciseSyntax: false });
    if (found.length >= 200) break;
  }
  return found;
}

export function buildMigrationRouteHints(snapshot, { maxHints = 20 } = {}) {
  if (!snapshot || typeof snapshot.id !== 'string' || !Array.isArray(snapshot.files) || snapshot.files.length > 200 || !Number.isSafeInteger(maxHints) || maxHints < 1 || maxHints > 20) throw new Error('Invalid migration route hint input');
  const limitations = [NOTICE], hints = [];
  if (snapshot.projectScope || snapshot.files.some(f => f.reviewMode === 'project')) return { hints, limitations: [...limitations, 'No approved historical baseline in project mode.'] };
  let chars = 0;
  for (const f of snapshot.files) if (f.eligibility === 'reviewable') for (const side of ['left', 'right']) { if (typeof f[side]?.text !== 'string') throw new Error('Missing approved source'); chars += f[side].text.length; }
  if (chars > 2 * 1024 * 1024) return { hints, limitations: [...limitations, 'Two MiB source-character budget exceeded; no hints inferred.'] };
  const approvedScope = createRetrievalScope(snapshot);
  const catalog = approvedScope.catalog(), rows = [];
  for (const f of snapshot.files) {
    if (f.eligibility !== 'reviewable' || !/\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/.test(f.path)) continue;
    if (f.left.text.length > 256 * 1024 || f.right.text.length > 256 * 1024) { limitations.push('Per-source 256 KiB character limit exceeded at ' + f.path); continue; }
    const old = mask(f.left.text), current = mask(f.right.text);
    if (old === undefined || current === undefined) { limitations.push('Unsupported literal/comment/line-splice syntax at ' + f.path); continue; }
    const changes = changeMap(f.left.text, f.right.text);
    if (/^\s*#/m.test(f.left.text + '\n' + f.right.text)) limitations.push('Preprocessor presence at ' + f.path + ': directives omitted, active branches unresolved.');
    rows.push({ f, old, current, changes, defs: definitions(f.right.text, current), oldDefs: definitions(f.left.text, old) });
  }
  const role = (row, side, line, symbol) => { const source = catalog.find(c => c.fileId === row.f.id && c.side === side); return { fileId: row.f.id, sourceId: source.id, path: source.path, side, line, hash: digest(side === 'old' ? row.f.left.text : row.f.right.text), symbol }; };
  const declared = new Set(rows.flatMap(row => [...row.defs, ...definitions(row.f.left.text, row.old)].map(def => def.symbol)));
  rows.sort((a, b) => Number(Boolean(a.f.left.text)) - Number(Boolean(b.f.left.text)) || a.f.path.localeCompare(b.f.path));
  let capped = false;
  const perFile = new Map();
  for (const row of rows) for (const def of row.defs) {
    if (row.changes.precision !== 'exact' || !row.changes.edits.some(e => e.new.count > 0 && e.new.start <= def.end && e.new.start + e.new.count > def.line)) continue;
    const tokens = new Set([def.symbol]);
    for (const line of row.current.split('\n').slice(def.line, def.end - 1)) for (const match of line.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) if (!['if', 'for', 'while', 'switch', 'catch', 'sizeof', 'return', 'static_cast', 'dynamic_cast'].includes(match[1]) && declared.has(match[1]) && tokens.size < 16) tokens.add(match[1]);
    const oldReferences = [];
    const previousRows = [...rows].sort((a, b) => Number(/extern\s+"C"/.test(b.f.left.text)) - Number(/extern\s+"C"/.test(a.f.left.text)));
    for (const previous of previousRows) {
      for (const [index, line] of previous.old.split('\n').entries()) {
        for (const symbol of tokens) if (new RegExp('(^|[^A-Za-z0-9_])' + symbol + '\\s*\\(').test(line)) { oldReferences.push(role(previous, 'old', index + 1, symbol)); break; }
        if (oldReferences.length >= 9) break;
      }
      if (oldReferences.length >= 9) break;
    }
    if (!oldReferences.length) continue;
    const bucket = perFile.get(row.f.id) ?? [];
    perFile.set(row.f.id, bucket);
    if (bucket.length === maxHints) { capped = true; continue; }
    const current = role(row, 'new', def.line, def.symbol);
    const enclosing = new Set();
    for (const ref of oldReferences.slice(0, 8)) {
      const previous = rows.find(value => value.f.id === ref.fileId);
      for (const owner of previous.oldDefs.filter(owner => owner.line <= ref.line && owner.end >= ref.line)) enclosing.add(owner.symbol);
    }
    const oldCallerReferences = [];
    oldCallers: for (const previous of previousRows) {
      for (const [index, line] of previous.old.split('\n').entries()) for (const symbol of enclosing) {
        if (oldReferences.some(ref => ref.fileId === previous.f.id && ref.line === index + 1)) continue;
        if (new RegExp('(^|[^A-Za-z0-9_])' + symbol + '\\s*\\(').test(line)) { oldCallerReferences.push(role(previous, 'old', index + 1, symbol)); if (oldCallerReferences.length >= 5) break oldCallers; break; }
      }
      if (oldCallerReferences.length >= 5) break;
    }
    const ambiguous = oldReferences.length !== 1 || oldReferences[0].symbol !== def.symbol || oldCallerReferences.length > 0;
    bucket.push({ id: 'route-hint-' + digest(JSON.stringify([snapshot.id, current, oldReferences, oldCallerReferences])).slice(0, 24), snapshotId: snapshot.id, candidateFileId: row.f.id, status: 'navigation-only', causality: 'unverified', ambiguous, new: current, oldReferences: oldReferences.slice(0, 8), oldCallerReferences: oldCallerReferences.slice(0, 4), sourceIds: [...new Set([current.sourceId, ...oldReferences.slice(0, 8).map(r => r.sourceId), ...oldCallerReferences.slice(0, 4).map(r => r.sourceId)])], unresolved: ['Lexical token matches only, not resolved calls, public visibility or same-function identity.', 'Read complete old wrapper guards and new state under the same trigger; shared helpers alone prove nothing.', ...(ambiguous ? ['Multiple endpoints or shared-token match; no semantic counterpart selected.'] : []), ...(oldReferences.length > 8 ? ['Old reference list truncated to eight.'] : []), ...(oldCallerReferences.length > 4 ? ['Old caller reference list truncated to four.'] : [])] });
  }
  // Fair deterministic allocation prevents one large source exhausting all navigation.
  for (let index = 0; index < maxHints; index++) for (const bucket of perFile.values()) if (bucket[index]) {
    if (hints.length < maxHints) hints.push(bucket[index]); else capped = true;
  }
  if (capped) limitations.push('Hint count limit reached; additional lexical matches omitted.');
  if (!hints.length) limitations.push('No supported changed-method token with old-side reference; absence of hints is not absence of a prior route.');
  return { hints, limitations: [...new Set(limitations)] };
}
