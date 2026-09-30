// Conservative naming hints only. No filesystem access or dependency claims.
export function inferTestRelations(files) {
  if (!Array.isArray(files) || files.length > 200) throw new Error('Invalid relation input');
  const paths = new Set(), ids = new Set(), implementations = new Map(), tests = [];
  for (const file of files) {
    if (!file || typeof file.id !== 'string' || !file.id || ids.has(file.id) || typeof file.path !== 'string' || !file.path || file.path.includes('\\') || file.path.split('/').some(p => !p || p === '.' || p === '..') || paths.has(file.path) || !['reviewable', 'blocked', 'excluded'].includes(file.eligibility)) throw new Error('Invalid relation file');
    ids.add(file.id); paths.add(file.path);
    if (file.eligibility !== 'reviewable') continue;
    const match = /^(.*)\.(mjs|cjs|js|jsx|ts|tsx)$/.exec(file.path);
    if (!match) continue;
    const stem = match[1], suffix = /\.(test|spec)$/.test(stem);
    const segments = stem.split('/');
    if (suffix || segments.some(s => ['test', 'tests', '__tests__'].includes(s))) {
      tests.push({ file, stem: stem.replace(/\.(test|spec)$/, ''), ext: match[2], suffix });
    } else implementations.set(file.path, file);
  }
  const edges = [];
  for (const { file, stem, ext, suffix } of tests) {
    const candidates = new Set();
    if (suffix) candidates.add(stem + '.' + ext);
    const parts = stem.split('/'), index = parts.findIndex(p => ['test', 'tests', '__tests__'].includes(p));
    if (index >= 0) {
      const without = [...parts]; without.splice(index, 1); candidates.add(without.join('/') + '.' + ext);
      if (index === 0) candidates.add('src/' + without.join('/') + '.' + ext);
    }
    const matches = [...candidates].map(p => implementations.get(p)).filter(Boolean);
    // Ambiguity is deliberately not resolved by basename or input order.
    if (matches.length === 1) edges.push({ from: matches[0].id, to: file.id, reason: 'implementation-test:naming' });
  }
  return edges.sort((a, b) => a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0);
}
