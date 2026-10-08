import path from 'node:path';

const extensions = ['.mjs', '.cjs', '.js', '.jsx', '.ts', '.tsx'];
// Conservative syntax hints, not a module resolver or a call graph. No I/O.
// Deliberately skip files containing block comments/templates rather than
// invent edges from text inside those constructs without a language parser.
export function inferImportRelations(files) {
  if (!Array.isArray(files) || files.length > 200) throw new Error('Invalid import relation input');
  const byPath = new Map(), ids = new Set();
  for (const file of files) {
    if (!file || typeof file.id !== 'string' || !file.id || ids.has(file.id) || typeof file.path !== 'string' || !file.path || file.path.includes('\\') || file.path.startsWith('/') || file.path.includes(':') || file.path.split('/').some(p => !p || p === '.' || p === '..') || byPath.has(file.path) || !['reviewable', 'blocked', 'excluded'].includes(file.eligibility)) throw new Error('Invalid import relation file');
    ids.add(file.id); byPath.set(file.path, file);
  }
  const edges = [];
  for (const file of [...files].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    if (file.eligibility !== 'reviewable' || !extensions.some(ext => file.path.endsWith(ext))) continue;
    for (const side of ['old', 'new']) {
      // Old-path module resolution for renames needs a separate path index.
      if (side === 'old' && file.oldPath && file.oldPath !== file.path) continue;
      const text = (side === 'old' ? file.left : file.right)?.text;
      if (typeof text !== 'string') throw new Error('Missing import relation source');
      if (Buffer.byteLength(text) > 256 * 1024 || text.includes('/*') || text.includes(String.fromCharCode(96))) continue;
      const lines = text.split(String.fromCharCode(10));
      for (let i = 0; i < lines.length; i++) {
        const match = /^\s*(?:import\s+(?:(?:[^'";]+)\s+from\s+)?|export\s+(?:[^'";]+)\s+from\s+)['"]([^'"\\]+)['"]\s*;?\s*(?:\/\/.*)?$/.exec(lines[i]);
        if (!match || !(match[1].startsWith('./') || match[1].startsWith('../'))) continue;
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), match[1]));
        if (target === '..' || target.startsWith('../') || target.includes(':')) continue;
        const paths = path.posix.extname(target) ? [target] : [target, ...extensions.map(ext => target + ext), ...extensions.map(ext => target + '/index' + ext)];
        // Blocked/excluded matches still create ambiguity, never silently pick another.
        const matches = [...new Set(paths)].map(p => byPath.get(p)).filter(Boolean);
        if (matches.length !== 1 || matches[0].eligibility !== 'reviewable' || matches[0].id === file.id) continue;
        edges.push({ from: file.id, to: matches[0].id, reason: 'relative-import:' + side + ':L' + (i + 1), side, line: i + 1, specifier: match[1] });
        if (edges.length >= 2000) return edges;
      }
    }
  }
  return edges.sort((a, b) => a.from.localeCompare(b.from, 'en') || a.to.localeCompare(b.to, 'en') || a.side.localeCompare(b.side, 'en') || a.line - b.line);
}
