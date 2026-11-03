import path from 'node:path';

const cpp = name => /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/.test(name);
const id = '[A-Za-z_][A-Za-z0-9_]*';
const signature = params => params.trim().replace(/\s+/g, ' ').replace(/\s*([*&])\s*/g, '$1');

// Evidence coordinates only, never resolved C++ call or reachability identities.
export function cppExportRouteDefinitions(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 256 * 1024 || /\/\*|R"|\\\r?\n|[\x60]/.test(text)) return [];
  const lines = text.split('\n').map(line => line.replace(/\r$/, '').replace(/\/\/.*$/, ''));
  if (lines.some(line => /^\s*#\s*(?!include\b)/.test(line) || /\b(?:namespace|template|using|typedef)\b/.test(line))) return [];
  const output = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*(?:(extern\s+"C")\s+(?:[A-Z_]\w*\s+)?)?(void|bool|int)\s+((?:[A-Za-z_]\w*::)?[A-Za-z_]\w*)\s*\(([^(){};]*)\)\s*(\{)?\s*$/.exec(lines[i]);
    if (!match || !match[1] && !match[3].includes('::')) continue;
    const params = match[4].split(',').map(p => p.trim());
    if (!params.every(p => /^(?:const\s+)?[A-Za-z_]\w*\s*[*&]?\s+[A-Za-z_]\w*$/.test(p))) continue;
    const brace = match[5] ? i : i + 1;
    if (!match[5] && !/^\s*\{\s*$/.test(lines[brace] ?? '')) continue;
    let depth = 1, end;
    for (let j = brace + 1; j < lines.length; j++) {
      if (/['"\\]/.test(lines[j])) break;
      for (const c of lines[j]) { if (c === '{') depth++; else if (c === '}') depth--; }
      if (depth === 0) { end = j + 1; break; }
      if (depth < 0) break;
    }
    if (end) output.push({ symbol: match[3], exported: Boolean(match[1]), params: signature(match[4]),
      names: params.map(p => /([A-Za-z_]\w*)$/.exec(p)[1]), start: i + 1, bodyStartLine: brace + 2, end, lines: lines.slice(brace + 1, end - 1) });
    if (output.length > 100) return [];
  }
  return output;
}

function linesOf(text, header) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 256 * 1024 || /\/\*|R"|\\\r?\n|[\x60]/.test(text)) return undefined;
  const lines = text.split('\n').map(line => line.replace(/\r$/, ''));
  const active = lines.map((line, i) => ({ line, i })).filter(row => row.line.trim() && !/^\s*\/\//.test(row.line));
  const directives = active.filter(row => /^\s*#/.test(row.line) && !/^\s*#\s*include\s*"[^"\\]+"\s*$/.test(row.line));
  if (directives.length) {
    const first = active[0], second = active[1], last = active.at(-1), guard = /^\s*#\s*ifndef\s+([A-Za-z_]\w*)\s*$/.exec(first?.line ?? '');
    if (!header || !guard || directives.length !== 3 || !new RegExp('^\\s*#\\s*define\\s+' + guard[1] + '\\s*$').test(second?.line ?? '') || !/^\s*#\s*endif\s*$/.test(last?.line ?? '')) return undefined;
    for (const row of [first, second, last]) lines[row.i] = '';
  }
  if (lines.some(line => {
    const plain = line.replace(/\/\/.*$/, '');
    return /\b(?:namespace|template|typedef|using|virtual|override|final)\b/.test(plain) ||
      !/^\s*#\s*include\s*"[^"\\]+"\s*$/.test(plain) && /['"]/.test(plain);
  })) return undefined;
  return lines;
}

function headers(entry) {
  const lines = linesOf(entry.text, true);
  if (!lines) return [];
  const classes = [];
  for (let i = 0; i < lines.length; i++) {
    const start = /^\s*class\s+([A-Za-z_]\w*)\s*\{\s*$/.exec(lines[i]);
    if (!start) continue;
    let access = 'private', methods = [], end;
    for (let j = i + 1; j < lines.length; j++) {
      const plain = lines[j].replace(/\/\/.*$/, '').trim();
      if (plain === '};') { end = j; break; }
      if (!plain) continue;
      if (/^(?:public|private|protected):$/.test(plain)) { access = plain.slice(0, -1); continue; }
      const method = /^(void|bool|int)\s+([A-Za-z_]\w*)\s*\(([^;{}]*)\)\s*;\s*$/.exec(plain);
      // Plain fields do not bind calls; they only allow the containing declaration
      // to remain navigable. Initializers, aliases and function pointers stay unsupported.
      if (!method && /^(?:bool|int|float|double|[A-Za-z_]\w*\s*[*&]?)\s+[A-Za-z_]\w*\s*;$/.test(plain)) continue;
      if (!method || /[=<>]|\bconst\b/.test(method[3])) { methods = undefined; break; }
      methods.push({ name: method[2], returnType: method[1], params: signature(method[3]), line: j + 1, access });
    }
    if (end !== undefined && methods && methods.every(m => methods.filter(other => other.name === m.name).length === 1)) classes.push({ entry, name: start[1], line: i + 1, methods });
  }
  // Multiple/nested classes, unsupported inheritance or unmatched declaration stay unresolved.
  const classTokens = lines.filter(line => /\bclass\b/.test(line.replace(/\/\/.*$/, ''))).length;
  return classTokens === classes.length ? classes : [];
}

function bodies(entry) {
  const lines = linesOf(entry.text, false);
  if (!lines) return [];
  const output = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*(void|bool|int)\s+([A-Za-z_]\w*)::([A-Za-z_]\w*)\s*\(([^;{}]*)\)\s*\{\s*$/.exec(lines[i]);
    if (!match || /[=<>]|\bconst\b/.test(match[4])) continue;
    let depth = 1, end;
    for (let j = i + 1; j < lines.length; j++) {
      const plain = lines[j].replace(/\/\/.*$/, '');
      if (/['"\/]/.test(plain)) break;
      for (const char of plain) { if (char === '{') depth++; else if (char === '}') depth--; }
      if (depth === 0) { end = j + 1; break; }
      if (depth < 0) break;
    }
    if (end) output.push({ entry, symbol: match[2] + '::' + match[3], className: match[2], method: match[3], returnType: match[1],
      params: signature(match[4]), start: i + 1, end, lines });
  }
  return output;
}

/** Entries are a single already-approved side, with stable source identities.
 * No source capture, semantic/type inference, inheritance or basename pairing.
 */
export function cppMigrationBindings(entries, { maxBindings = 2000 } = {}) {
  if (!Array.isArray(entries) || entries.length > 200 || !Number.isSafeInteger(maxBindings) || maxBindings < 1 || maxBindings > 2000) throw new Error('Invalid C++ migration binding input');
  const result = { definitions: [], bindings: [], limitations: [] }, seen = new Set();
  for (const e of entries) {
    if (!e || typeof e.id !== 'string' || seen.has(e.id) || typeof e.path !== 'string' || !e.source || typeof e.source.id !== 'string') throw new Error('Invalid approved C++ migration entry');
    seen.add(e.id);
  }
  const all = entries.filter(e => e.eligibility === 'reviewable' && cpp(e.path)), declarations = all.flatMap(headers), implementations = all.flatMap(bodies);
  if (declarations.length > 2000 || implementations.length > 2000) return { ...result, limitations: ['C++ migration definition budget exceeded; identities unresolved.'] };
  const includeCache = new Map();
  const includes = entry => {
    if (includeCache.has(entry.id)) return includeCache.get(entry.id);
    const lines = linesOf(entry.text, false); if (!lines) return [];
    const edges = lines.flatMap((line, index) => {
      const match = /^\s*#\s*include\s*"([^"\\]+)"\s*$/.exec(line); if (!match) return [];
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entry.path), match[1]));
      if (resolved.startsWith('../') || resolved.startsWith('/') || resolved.includes(':')) return [];
      const matches = entries.filter(e => e.path === resolved);
      return matches.length === 1 && matches[0].eligibility === 'reviewable' ? [{ to: matches[0].id, line: index + 1 }] : [];
    });
    includeCache.set(entry.id, edges); return edges;
  };
  const rawClasses = entries.filter(e => cpp(e.path) && typeof e.text === 'string').flatMap(e =>
    [...e.text.matchAll(/\bclass\s+([A-Za-z_]\w*)/g)].map(match => ({ name: match[1], entryId: e.id })));
  const rawDefinitions = entries.filter(e => cpp(e.path) && typeof e.text === 'string').flatMap(e =>
    [...e.text.matchAll(/^\s*(?:[A-Za-z_]\w*\s+)+([A-Za-z_]\w*)::([A-Za-z_]\w*)\s*\(/gm)]
      .map(match => match[1] + '::' + match[2]));
  const resolved = [];
  for (const body of implementations) {
    const candidates = declarations.filter(d => d.name === body.className && includes(body.entry).some(e => e.to === d.entry.id));
    const uniqueClass = declarations.filter(d => d.name === body.className);
    const duplicateBody = implementations.filter(d => d.symbol === body.symbol);
    if (candidates.length !== 1 || uniqueClass.length !== 1 || rawClasses.filter(c => c.name === body.className).length !== 1 || duplicateBody.length !== 1 || rawDefinitions.filter(symbol => symbol === body.symbol).length !== 1) continue;
    const declaration = candidates[0], method = declaration.methods.find(m => m.name === body.method && m.returnType === body.returnType && m.params === body.params);
    if (!method) continue;
    const navigation = { sourceId: declaration.entry.source.id, side: declaration.entry.source.side, path: declaration.entry.path, sourcePath: declaration.entry.source.path ?? declaration.entry.path,
      line: method.line, className: declaration.name, symbol: body.symbol, confidence: 'exact-declaration-syntax-only' };
    if (result.definitions.length >= 2000) { result.limitations = ['C++ migration definition limit reached; remaining identities unresolved.']; break; }
    resolved.push({ ...body, declaration, method, navigation });
    result.definitions.push({ fileId: body.entry.id, symbol: body.symbol, start: body.start, end: body.end, navigation });
  }
  for (const body of resolved) {
    const params = body.params ? body.params.split(',').map(p => p.trim()) : [];
    const receivers = params.map(param => new RegExp('^(' + id + ')([&*])(' + id + ')$').exec(param)).filter(Boolean);
    for (const receiver of receivers) {
      const [, className, pointer, local] = receiver, operator = pointer === '*' ? '->' : '.';
      const visible = declarations.filter(d => d.name === className && includes(body.entry).some(e => e.to === d.entry.id));
      if (visible.length !== 1 || declarations.filter(d => d.name === className).length !== 1 ||
          rawClasses.filter(c => c.name === className).length !== 1 || local === 'this') continue;
      const token = new RegExp('(^|[^A-Za-z0-9_])' + local + '(?=[^A-Za-z0-9_]|$)', 'g');
      const callPattern = new RegExp('^\\s*' + local + (operator === '.' ? '\\.' : '->') + '(' + id + ')\\s*\\(([^;\"\'{}\\/]*)\\)\\s*;\\s*$');
      const calls = []; let safe = params.filter(p => new RegExp('(^|[^A-Za-z0-9_])' + local + '(?=[^A-Za-z0-9_]|$)').test(p)).length === 1;
      for (let i = body.start; i < body.end - 1; i++) {
        const line = body.lines[i], occurrences = [...line.matchAll(token)]; if (!occurrences.length) continue;
        const call = callPattern.exec(line);
        if (!call || occurrences.length !== 1) { safe = false; break; }
        calls.push({ method: call[1], args: call[2], line: i + 1 });
      }
      if (!safe) continue;
      for (const call of calls) {
        const method = visible[0].methods.find(m => m.name === call.method && m.access === 'public');
        const targets = resolved.filter(d => d.className === className && d.method.name === call.method);
        if (!method || targets.length !== 1) continue;
        const expected = method.params ? method.params.split(',').length : 0, actual = call.args.trim() ? call.args.split(',').length : 0;
        if (expected !== actual || !/^(?:\s*(?:[A-Za-z_]\w*|[0-9]+)(?:\s*,\s*(?:[A-Za-z_]\w*|[0-9]+))*\s*)?$/.test(call.args)) continue;
        if (result.bindings.length >= maxBindings) { result.limitations = ['C++ migration binding limit reached; remaining identities unresolved.']; break; }
        const target = targets[0], include = includes(body.entry).find(e => e.to === visible[0].entry.id);
        result.bindings.push({ from: body.entry.id, to: target.entry.id, importLine: include.line, callLine: call.line,
          symbol: target.symbol, declarationLine: target.start, navigationBindings: [body.navigation, target.navigation,
            { sourceId: body.entry.source.id, side: body.entry.source.side, path: body.entry.path, sourcePath: body.entry.source.path ?? body.entry.path, line: body.start,
              className, receiver: local, receiverKind: pointer === '*' ? 'pointer-parameter' : 'reference-parameter', confidence: 'explicit-receiver-syntax-only' }] });
      }
    }
  }
  if (resolved.length < implementations.length) result.limitations.push('Some C++ class declarations or out-of-line definitions remain ambiguous or unsupported.');
  return result;
}
