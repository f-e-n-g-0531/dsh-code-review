import { createHash } from 'node:crypto';
const NOTICE = 'Lexical branch inventory only: no defect, reachable trigger, guard semantics, macro expansion, accepted-request behavior or source authorization is established.';
function mask(text) {
  if (/R"|\x60|\\\r?\n/.test(text)) return undefined;
  let output = '', state = 'code';
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (state === 'line') { output += c === '\n' ? c : ' '; if (c === '\n') state = 'code'; continue; }
    if (state === 'block') { if (c === '*' && n === '/') { output += '  '; i++; state = 'code'; } else output += c === '\n' ? c : ' '; continue; }
    if (state === '"' || state === "'") {
      if (c === '\n' || c === '\r') return undefined;
      if (c === '\\') { if (n === undefined) return undefined; output += '  '; i++; }
      else { output += ' '; if (c === state) state = 'code'; }
      continue;
    }
    if (c === '/' && n === '/') { output += '  '; i++; state = 'line'; }
    else if (c === '/' && n === '*') { output += '  '; i++; state = 'block'; }
    else if (c === '"' || c === "'") { output += ' '; state = c; }
    else output += c;
  }
  return state === 'block' || state === '"' || state === "'" ? undefined : output;
}
export function buildRejectionBranchNavigation(file, { maxBranches = 24 } = {}) {
  if (!file || typeof file.id !== 'string' || !file.id || typeof file.path !== 'string' || !file.path || !Number.isSafeInteger(maxBranches) || maxBranches < 1 || maxBranches > 24 || typeof file.left?.text !== 'string' || typeof file.right?.text !== 'string') throw new Error('Invalid rejection navigation input');
  const branches = [], limitations = [], rows = { old: [], new: [] };
  for (const side of ['old', 'new']) {
    const text = side === 'old' ? file.left.text : file.right.text;
    if (Buffer.byteLength(text) > 256 * 1024) { limitations.push(side + ': per-source 256 KiB limit exceeded; not scanned.'); continue; }
    const clean = mask(text);
    if (clean === undefined) { limitations.push(side + ': raw/template string, line splice or malformed literal/comment unsupported; not scanned.'); continue; }
    const hash = createHash('sha256').update(text).digest('hex');
    let conditional = false;
    for (const [index, line] of clean.split('\n').entries()) {
      if (/^\s*#/.test(line)) { conditional = true; continue; }
      const base = { fileId: file.id, path: file.path, side, hash, line: index + 1, status: 'navigation-only', semantics: 'unresolved' };
      const literal = /\breturn\s+(false|nullptr|NULL|null)\s*;/.exec(line);
      if (literal) rows[side].push({ ...base, kind: literal[1] === 'false' ? 'literal-return-false' : 'literal-return-null' });
      // Uppercase spelling is a lexical candidate only, never proof of a macro or exit.
      const call = /^\s*([A-Z_][A-Z0-9_]*)\s*\([^;{}]*\)\s*;?\s*$/.exec(line);
      if (call) rows[side].push({ ...base, kind: 'macro-call-unresolved' });
    }
    if (conditional) limitations.push(side + ': preprocessor directives skipped; active branches and macro semantics unresolved.');
  }
  for (let index = 0; index < maxBranches; index++) for (const side of ['old', 'new']) if (rows[side][index] && branches.length < maxBranches) branches.push(rows[side][index]);
  if (rows.old.length + rows.new.length > branches.length) limitations.push('Branch cap reached; omitted old=' + (rows.old.length - branches.filter(r => r.side === 'old').length) + ', new=' + (rows.new.length - branches.filter(r => r.side === 'new').length) + '. Inventory is incomplete.');
  return { branches, limitations, notice: NOTICE };
}
