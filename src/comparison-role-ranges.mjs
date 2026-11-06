import { createHash } from 'node:crypto';
import { createRetrievalScope } from './retrieval-scope.mjs';

const NOTICE = 'Text ranges only; not semantic identity, active preprocessor branch, reachability, migration relationship or causal proof. Fresh approved reads remain required.';
const sha = text => createHash('sha256').update(text).digest('hex');
function masked(text) {
  if (/R"|\x60|\\\r?\n/.test(text)) return undefined;
  let result = '', state = 'code';
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (state === 'line') { result += c === '\n' ? c : ' '; if (c === '\n') state = 'code'; continue; }
    if (state === 'block') { if (c === '*' && n === '/') { result += '  '; i++; state = 'code'; } else result += c === '\n' ? c : ' '; continue; }
    if (state === '"' || state === "'") {
      if (c === '\n' || c === '\r') return undefined;
      if (c === '\\') { if (n === undefined) return undefined; result += '  '; i++; }
      else { result += ' '; if (c === state) state = 'code'; }
      continue;
    }
    if (c === '/' && n === '/') { state = 'line'; result += '  '; i++; }
    else if (c === '/' && n === '*') { state = 'block'; result += '  '; i++; }
    else if (c === '"' || c === "'") { state = c; result += ' '; }
    else result += c;
  }
  return state === 'block' || state === '"' || state === "'" ? undefined : result;
}
function scan(text) {
  const clean = masked(text);
  if (clean === undefined) return { error: 'Unsupported raw/template string, line splice or unclosed literal/comment.' };
  const lines = clean.split('\n'), depth = [], conditional = [], directives = [];
  let braces = 0, conditions = 0;
  for (let i = 0; i < lines.length; i++) {
    depth[i] = braces; conditional[i] = conditions;
    const directive = /^\s*#\s*(\w+)/.exec(lines[i]);
    if (directive) {
      directives.push(i);
      if (/^(if|ifdef|ifndef)$/.test(directive[1])) conditions++;
      else if (directive[1] === 'endif') { if (--conditions < 0) return { error: 'Unbalanced preprocessor condition.' }; }
      else if (/^(else|elif)$/.test(directive[1]) && !conditions) return { error: 'Unbalanced preprocessor condition.' };
      continue;
    }
    for (const c of lines[i]) { if (c === '{') braces++; else if (c === '}' && --braces < 0) return { error: 'Unbalanced braces.' }; }
  }
  if (braces || conditions) return { error: 'Unbalanced braces or preprocessor condition.' };
  const ranges = []; let unsupported = false;
  for (let i = 0; i < lines.length; i++) {
    if (depth[i] !== 0 || conditional[i] !== 0 || /^\s*#/.test(lines[i])) continue;
    const line = lines[i].replace(/\r$/, '');
    const js = /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^(){};]*\)\s*$/.exec(line);
    const cpp = /^\s*(?:(?:inline|static|extern)\s+)*(?:[A-Za-z_]\w*(?:::\w+)*(?:\s*[*&])?\s+)+((?:[A-Za-z_]\w*::)*[A-Za-z_]\w*)\s*\([^(){};]*\)\s*(?:const\s*)?$/.exec(line);
    const match = js ?? cpp;
    if (!match || /\b(namespace|template|typedef|using|class|struct)\b/.test(line) || !/^\s*\{\s*$/.test(lines[i + 1] ?? '')) { if (/\(/.test(line) && !/;\s*$/.test(line)) unsupported = true; continue; }
    let end = i + 2;
    while (end < lines.length && !(depth[end] === 1 && /^\s*}\s*$/.test(lines[end]))) end++;
    if (end === lines.length) { unsupported = true; continue; }
    if (directives.some(index => index >= i && index <= end)) { unsupported = true; i = end; continue; }
    ranges.push({ start: i + 1, count: end - i + 1, symbol: match[1] });
    i = end;
  }
  return { ranges, unsupported, directives: directives.length > 0 };
}

export function buildComparisonRoleRanges(snapshot, { sourceIds } = {}) {
  if (!snapshot || typeof snapshot.id !== 'string' || !snapshot.id || !Array.isArray(snapshot.files) || snapshot.files.length > 200) throw new Error('Invalid comparison range snapshot');
  if (sourceIds !== undefined && (!Array.isArray(sourceIds) || sourceIds.length < 1 || sourceIds.length > 16 || sourceIds.some(id => typeof id !== 'string' || !id) || new Set(sourceIds).size !== sourceIds.length)) throw new Error('Invalid comparison source filter');
  const ranges = [], limitations = [NOTICE];
  let bytes = 0;
  for (const f of snapshot.files) if (f.eligibility === 'reviewable') for (const side of ['left', 'right']) { if (typeof f[side]?.text !== 'string') throw new Error('Missing captured source'); bytes += Buffer.byteLength(f[side].text); }
  for (const item of snapshot.context ?? []) for (const key of ['text', 'oldText']) if (typeof item[key] === 'string') bytes += Buffer.byteLength(item[key]);
  if (bytes > 2 * 1024 * 1024) return { ranges, limitations: [...limitations, 'Total captured source exceeds 2 MiB; no textual ranges scanned.'] };
  const scope = createRetrievalScope(snapshot), catalog = scope.catalog();
  if (sourceIds?.some(id => !catalog.some(source => source.id === id))) throw new Error('Unknown comparison source filter');
  const selected = sourceIds ? catalog.filter(source => sourceIds.includes(source.id)) : catalog;
  for (const source of selected) {
    if (!/\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|js|mjs|cjs|ts)$/.test(source.path)) continue;
    const f = snapshot.files.find(f => f.id === source.fileId);
    const context = source.fileId ? undefined : snapshot.context.find(c => c.path === source.path);
    const text = f ? (source.side === 'old' ? f.left.text : f.right.text) : source.side === 'context-old' ? context.oldText : context.text;
    if (Buffer.byteLength(text) > 256 * 1024) { limitations.push('Per-source 256 KiB limit exceeded: ' + source.id); continue; }
    const scanned = scan(text);
    if (scanned.error) { limitations.push(source.id + ': ' + scanned.error); continue; }
    if (scanned.directives) limitations.push(source.id + ': preprocessor directives unresolved; conditional bodies excluded, outside macros not expanded.');
    if (scanned.unsupported) limitations.push(source.id + ': unsupported or multiline/nested function syntax omitted; no completeness claim.');
    for (const range of scanned.ranges) {
      if (ranges.length === 200) return { ranges, limitations: [...limitations, 'Range count limit 200 reached; remaining ranges omitted.'] };
      ranges.push({ snapshotId: snapshot.id, sourceId: source.id, ...(source.fileId ? { fileId: source.fileId } : {}), path: source.path, side: source.side, hash: sha(text), ...range, textRangeOnly: true, relationshipStatus: 'unverified' });
    }
  }
  return { ranges, limitations };
}
