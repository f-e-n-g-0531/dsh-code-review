// Conservative direct exported-function hints, never execution/reachability proof.
export function directImportBindings(lines, importLine, calls, targetText) {
 if (typeof targetText !== 'string' || Buffer.byteLength(targetText) > 256 * 1024 || /[\x60]|\/\*/.test(targetText)) return [];
 const match = /^\s*import\s+\{([^}]+)\}\s+from\s+(['"])[^'"]+\2\s*;?\s*(?:\/\/.*)?$/.exec(lines[importLine - 1]);
 if (!match) return [];
 const bindings = match[1].split(',').map(part => /^\s*([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?\s*$/.exec(part));
 if (bindings.some(b => !b)) return [];
 const targets = targetText.split(String.fromCharCode(10)), result = [];
 for (const binding of bindings) {
  const imported = binding[1], local = binding[2] ?? imported;
  const token = new RegExp('(^|[^A-Za-z0-9_$])' + local.replaceAll('$', '\\$') + '([^A-Za-z0-9_$]|$)');
  const positions = calls.filter(c => c.local === local);
  if (!positions.length) continue;
  // Arguments may mutate/escape the alias on the SAME indexed call line.
  // Keep a hint only when the sole local token is the call callee.
  const occurrences = new RegExp('(^|[^A-Za-z0-9_$])' + local.replaceAll('$', '\\$') + '(?=[^A-Za-z0-9_$]|$)', 'g');
  if (positions.some(call => [...lines[call.line - 1].matchAll(occurrences)].length !== 1)) continue;
  // Every other occurrence may be declaration, parameter, mutation or escape.
  if (lines.some((line, i) => i + 1 !== importLine && !positions.some(c => c.line === i + 1) && token.test(line))) continue;
  const declarations = uniqueApprovedDeclarations(targets, imported);
  if (declarations.length !== 1) continue;
  const exportedToken = new RegExp('(^|[^A-Za-z0-9_$])' + imported.replaceAll('$', String.fromCharCode(92) + '$') + '([^A-Za-z0-9_$]|$)');
  if (targets.some((line, i) => i + 1 !== declarations[0].number && exportedToken.test(line))) continue;
  result.push(...positions.map(call => ({ imported, local, importLine, callLine: call.line, declarationLine: declarations[0].number, declarationKind: declarations[0].kind, confidence: 'conservative-syntax-only' })));
 }
 return result.slice(0, 20);
}

// Only one direct declaration inside already approved text. No extra file reads.
export function uniqueApprovedDeclarations(lines, imported) {
 if (!Array.isArray(lines) || lines.length > 20000 || typeof imported !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(imported)) return [];
 const text=lines.join(String.fromCharCode(10));
 if (lines.some(line=>typeof line!=='string') || Buffer.byteLength(text)>256*1024 || text.includes('/*') || text.includes(String.fromCharCode(96)) || text.includes(String.fromCharCode(92,10)) || text.includes(String.fromCharCode(92,13,10))) return [];
 const forms = [
  ['function', /^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/],
  ['const', /^\s*export\s+(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/],
  ['class', /^\s*export\s+class\s+([A-Za-z_$][A-Za-z0-9_$]*)(?=\s|\{)/]
 ];
 const found = [];
 for (let i = 0; i < lines.length; i++) {
  for (const [kind, pattern] of forms) {
   if (pattern.exec(lines[i])?.[1] === imported) found.push({ number: i + 1, kind });
  }
 }
 if (found.length !== 1) return [];
 const occurrences=new RegExp('(^|[^A-Za-z0-9_$])'+imported.replaceAll('$','\\$')+'(?=[^A-Za-z0-9_$]|$)','g');
 if ([...lines[found[0].number-1].matchAll(occurrences)].length!==1) return [];
 const token = new RegExp('(^|[^A-Za-z0-9_$])' + imported.replaceAll('$', '\\$') + '([^A-Za-z0-9_$]|$)');
 if (lines.some((line, i) => i + 1 !== found[0].number && token.test(line))) return [];
 return found;
}

// Named imports only. Missing, duplicate, comment, or reexport names stay unresolved.
export function namedImportDefinitions(importLine, targetText) {
 if (typeof targetText !== 'string' || Buffer.byteLength(targetText) > 256 * 1024 || /[\x60]|\/\*/.test(targetText)) return [];
 const match = /^\s*import\s+\{([^}]+)\}\s+from\s+(['"])[^'"]+\2\s*;?\s*(?:\/\/.*)?$/.exec(importLine);
 if (!match) return [];
 const names = match[1].split(',').map(part => /^\s*([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?\s*$/.exec(part));
 if (!names.length || names.some(item => !item) || new Set(names.map(item => item[1])).size !== names.length || new Set(names.map(item => item[2] ?? item[1])).size !== names.length) return [];
 const lines = targetText.split(String.fromCharCode(10)), result = [];
 for (const name of names) {
  const found = uniqueApprovedDeclarations(lines, name[1]);
  if (found.length === 1) result.push({ imported: name[1], declarationLine: found[0].number, declarationKind: found[0].kind, confidence: 'approved-unique-syntax-only' });
 }
 return result.slice(0, 20);
}
