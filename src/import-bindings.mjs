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
  // Every other occurrence may be declaration, parameter, mutation or escape.
  if (lines.some((line, i) => i + 1 !== importLine && !positions.some(c => c.line === i + 1) && token.test(line))) continue;
  const declarations = targets.map((line, i) => ({ line, number: i + 1 })).filter(item => /^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/.exec(item.line)?.[1] === imported);
  if (declarations.length !== 1) continue;
  result.push(...positions.map(call => ({ imported, local, importLine, callLine: call.line, declarationLine: declarations[0].number, confidence: 'conservative-syntax-only' })));
 }
 return result.slice(0, 20);
}
