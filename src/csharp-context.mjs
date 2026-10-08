// Approved text only, no compiler/module lookup. Intentionally narrow syntax hints.
const safe = text => typeof text === 'string' && Buffer.byteLength(text) <= 256 * 1024 && !/["'\x60#]|\/\/|\/\*/.test(text);
const namespaceOf = text => { const matches = [...text.matchAll(/^\s*namespace\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;\s*$/gm)]; return matches.length === 1 ? matches[0][1] : null; };
export function inferCsharpContext(input, primary) {
 if (!primary.path.endsWith('.cs')) return [];
 const contexts = (input.context ?? []).filter(c => c.path.endsWith('.cs') && !input.files.some(f => f.path === c.path));
 const result = [];
 for (const side of ['old', 'new']) {
  const source = (side === 'old' ? primary.left : primary.right)?.text;
  if (!safe(source) || /\busing\b|\bdynamic\b/.test(source)) continue;
  const ns = namespaceOf(source); if (!ns) continue;
  const lines = source.split(String.fromCharCode(10));
  for (let i = 0; i < lines.length; i++) {
   const call = /^\s*(?:await\s+)?([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)\s*;\s*$/.exec(lines[i]);
   if (!call) continue;
   const [, type, method] = call;
   const token = new RegExp('\\b' + type + '\\b');
   // Other occurrences may introduce a variable/type that shadows the qualifier.
   if (lines.some((line,j) => j !== i && token.test(line))) continue;
   // Unsupported declarations still compete; filtering them out must not create uniqueness.
   const competitors = contexts.filter(c => typeof c.text !== 'string' || token.test(c.text));
   if (competitors.length !== 1 || input.files.some(f => f !== primary && f.path.endsWith('.cs') && f.path.split('/').at(-1) === type + '.cs')) continue;
   const candidates = competitors.filter(c => safe(c.text) && namespaceOf(c.text) === ns && !/\busing\b|\bpartial\b|\bvirtual\b|\boverride\b|\binterface\b/.test(c.text));
   const declarations = [];
   for (const context of candidates) {
    const targetLines = context.text.split(String.fromCharCode(10));
    const classes = targetLines.map((line,j) => ({ line, number:j+1 })).filter(item => /^\s*(?:public|internal)\s+static\s+class\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{?\s*$/.exec(item.line)?.[1] === type);
    // Only one type per file; no nesting, inheritance, generics or partial resolution.
    if (classes.length !== 1 || (context.text.match(/\bclass\b|\bstruct\b|\brecord\b/g) ?? []).length !== 1) continue;
    const occurrences = targetLines.filter(line => new RegExp('\\b' + method + '\\s*\\(').test(line));
    const methods = targetLines.map((line,j) => ({ line, number:j+1 })).filter(item => new RegExp('^\\s*public\\s+static\\s+(?:void|int|bool|string)\\s+' + method + '\\s*\\(\\s*\\)\\s*(?:\\{|$)').test(item.line));
    if (occurrences.length === 1 && methods.length === 1) declarations.push({ contextPath:context.path, typeLine:classes[0].number, declarationLine:methods[0].number });
   }
   if (declarations.length === 1) result.push({ primaryPath:primary.path, side, contextVersion:'approved-current-not-historical', callLine:i+1, namespace:ns, type, method, ...declarations[0], confidence:'conservative-syntax-only' });
   if (result.length >= 20) return result;
  }
 }
 return result;
}
