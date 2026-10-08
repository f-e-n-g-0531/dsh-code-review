// Syntactic occurrences only, never binding resolution or reachability.
export function importedCallSites(lines, importLine) {
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
  const calls = [];
  for (let i = 0; i < lines.length && calls.length < 20; i++) {
    // A narrow standalone expression, not a lexical or scope parser.
    const call = /^\s*(?:await\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^;"'\/]*\)\s*;?\s*$/.exec(lines[i]);
    if (call && names.includes(call[1])) calls.push({ local: call[1], line: i + 1 });
  }
  return calls;
}
