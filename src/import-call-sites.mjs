// Syntactic occurrences only, never binding resolution or reachability.
export function indexStandaloneCalls(lines) {
  const index = new Map();
  for (let i = 0; i < lines.length; i++) {
    const call = /^\s*(?:await\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^;"'\/]*\)\s*;?\s*$/.exec(lines[i]);
    if (!call) continue;
    const positions = index.get(call[1]) ?? [];
    if (positions.length < 20) positions.push(i + 1);
    index.set(call[1], positions);
  }
  return index;
}
export function importedCallSites(lines, importLine, callIndex = indexStandaloneCalls(lines)) {
  const match = /^\s*import\s+(.+?)\s+from\s+(['"])([^'"\\]+)\2\s*;?\s*(?:\/\/.*)?$/.exec(lines[importLine - 1]);
  if (!match || match[1].startsWith('type ')) return [];
  const names = [];
  const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  if (identifier.test(match[1])) names.push(match[1]);
  else if (match[1].startsWith('{') && match[1].endsWith('}')) {
    for (const part of match[1].slice(1, -1).split(',')) {
      const binding = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?\s*$/.exec(part);
      if (!binding) return [];
      names.push(binding[2] ?? binding[1]);
    }
  }
  const calls = names.flatMap(local => (callIndex.get(local) ?? []).map(line => ({ local, line }))).sort((a, b) => a.line - b.line).slice(0, 20);
  return calls;
}
