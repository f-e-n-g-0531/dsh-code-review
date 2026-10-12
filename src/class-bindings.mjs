// Conservative instance-method navigation over approved bodies only. No type or
// inheritance inference. Shadowing, mutation, accessors, static, nested, computed
// and duplicate definitions are all refused.
const BS = String.fromCharCode(96);
const NL = String.fromCharCode(10);
function classBody(lines, classLine) {
  const col = lines[classLine - 1].indexOf('{');
  if (col < 0) return null;
  const rest = lines.slice(classLine - 1).join(NL).slice(col + 1);
  let depth = 1, i = 0, out = '';
  while (i < rest.length && depth > 0) {
    const ch = rest[i];
    if (ch === '"' || ch === "'" || ch === BS) {
      const q = ch; out += ch; i++;
      while (i < rest.length && rest[i] !== q) { out += rest[i]; if (rest[i] === '\\' && i + 1 < rest.length) { out += rest[i + 1]; i += 2; continue; } i++; }
      if (i < rest.length) { out += rest[i]; i++; }
      continue;
    }
    if (ch === '/' && rest[i + 1] === '/') { const e = rest.indexOf(NL, i); i = e < 0 ? rest.length : e; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return out; }
    out += ch; i++;
  }
  return null;
}
function directMethods(body) {
  const out = [];
  let depth = 0;
  for (let i = 0; i < body.length;) {
    const ch = body[i];
    if (ch === '"' || ch === "'" || ch === BS) { const q = ch; i++; while (i < body.length && body[i] !== q) { if (body[i] === '\\') i++; i++; } i++; continue; }
    if (ch === '/' && body[i + 1] === '/') { const e = body.indexOf(NL, i); i = e < 0 ? body.length : e; continue; }
    if (ch === '{') { depth++; i++; continue; }
    if (ch === '}') { depth--; i++; continue; }
    if (depth === 0) {
      const m = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/.exec(body.slice(i));
      if (m) { out.push({ name: m[1], i }); i += m[0].length; continue; }
    }
    i++;
  }
  return out;
}
export function instanceMethodBindings(lines, importLine, targetText) {
  if (!Array.isArray(lines) || lines.length > 20000 || typeof targetText !== 'string') return [];
  const caller = lines.join(NL);
  if (Buffer.byteLength(caller) > 256 * 1024 || caller.includes('/*') || caller.includes(BS) || /\\\r?\n/.test(caller)) return [];
  const imports = /^\s*import\s+\{([^}]+)\}\s+from\s+(['"])([^'"\\]+)\2\s*;?\s*(?:\/\/.*)?$/.exec(lines[importLine - 1]);
  if (!imports) return [];
  const parts = imports[1].split(',').map(p => /^\s*([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?\s*$/.exec(p));
  if (parts.some(p => !p)) return [];
  const klass = parts.length === 1 ? parts[0][1] : null;
  if (!klass) return [];
  const local = parts[0][2] ?? klass;
  if (Buffer.byteLength(targetText) > 256 * 1024 || targetText.includes('/*') || targetText.includes(BS) || /\\\r?\n/.test(targetText)) return [];
  const targets = targetText.split(NL);
  let classLine = null;
  for (let i = 0; i < targets.length; i++) {
    const m = /^\s*export\s+class\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(targets[i]);
    if (m && m[1] === klass) { if (classLine !== null) return []; classLine = i + 1; }
  }
  if (classLine === null) return [];
  if (/\bextends\b|\bimplements\b/.test(targets[classLine - 1])) return [];
  const braceCol = targets[classLine - 1].indexOf('{');
  if (braceCol >= 0 && /[<>]/.test(targets[classLine - 1].slice(0, braceCol))) return [];
  const body = classBody(targets, classLine);
  if (!body) return [];
  const decls = directMethods(body);
  const names = {};
  for (const d of decls) names[d.name] = (names[d.name] ?? 0) + 1;
  const result = [];
  for (const d of decls) {
    if (names[d.name] !== 1) continue;
    if (d.name === 'constructor') continue;
    const member = d.name;
    const token = new RegExp('(^|[^A-Za-z0-9_$])' + member.replaceAll('$', '\\$') + '(?=[^A-Za-z0-9_$]|$)', 'g');
    const occ = [];
    let m; while ((m = token.exec(body)) !== null) occ.push(m.index);
    if (occ.length !== 1) continue;
    const before = body.slice(0, d.i);
    const spanStart = Math.max(before.lastIndexOf('}'), before.lastIndexOf(';'), before.lastIndexOf('{'));
    const span = before.slice(spanStart + 1);
    if (/\b(?:static|get|set|abstract)\b/.test(span)) continue;
    if (/=\s*$/.test(span)) continue;
    const seg = span.slice(span.lastIndexOf(NL) + 1);
    if (/[=,:.*#\[\]()]|\b(?:new|function|return|yield|case|throw|typeof|void|delete|instanceof)\b/.test(seg)) continue;
    let assign = null, inst = null;
    for (let i = 0; i < lines.length; i++) {
      const a = /^\s*(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*new\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/.exec(lines[i]);
      if (a && a[2] === local) { if (assign !== null) return []; assign = i + 1; inst = a[1]; }
    }
    if (assign === null || inst === member || inst === klass || inst === local) continue;
    const newCount = [...caller.matchAll(new RegExp('(^|[^A-Za-z0-9_$])new\\s+' + local.replaceAll('$', '\\$') + '\\s*\\(', 'g'))].length;
    if (newCount !== 1) continue;
    const instToken = new RegExp('(^|[^A-Za-z0-9_$])' + inst.replaceAll('$', '\\$') + '(?=[^A-Za-z0-9_$]|$)', 'g');
    const instLines = [];
    for (let i = 0; i < lines.length; i++) { const o = [...lines[i].matchAll(instToken)]; if (o.length) { if (o.length !== 1) return []; instLines.push(i + 1); } }
    if (instLines.length !== 2 || !instLines.includes(assign)) continue;
    const callLine = instLines.find(l => l !== assign);
    const callRe = new RegExp('^\\s*(?:await\\s+)?' + inst.replaceAll('$', '\\$') + '\\.([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\([^();"\x27/]*\\)\\s*;?\\s*$');
    const call = callRe.exec(lines[callLine - 1]);
    if (!call || call[1] !== member) continue;
    const methodLine = classLine + (body.slice(0, d.i).split(NL).length - 1);
    result.push({ imported: klass, local, instance: inst, member, newLine: assign, callLine, methodLine, declarationKind: 'instance-method', confidence: 'instance-method-syntax-only' });
  }
  return result.slice(0, 20);
}
