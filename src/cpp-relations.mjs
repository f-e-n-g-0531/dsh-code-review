import path from 'node:path';
const cpp = p => /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/.test(p);
// Same-directory names and literal quoted includes are navigation hints, not builds.
export function inferCppRelations(files) {
 if (!Array.isArray(files) || files.length > 200) throw new Error('Invalid C++ relation input');
 const byPath = new Map(), ids = new Set();
 for (const file of files) {
  if (!file || typeof file.id !== 'string' || !file.id || ids.has(file.id) || typeof file.path !== 'string' || !file.path || file.path.includes('\\') || file.path.includes(':') || file.path.startsWith('/') || file.path.split('/').some(s => !s || s === '.' || s === '..') || byPath.has(file.path) || !['reviewable','excluded','blocked'].includes(file.eligibility)) throw new Error('Invalid C++ relation file');
  ids.add(file.id); byPath.set(file.path,file);
 }
 const edges = [];
 for (const file of files.filter(f => f.eligibility === 'reviewable' && cpp(f.path))) {
  const stem = file.path.replace(/\.[^.]+$/, '');
  const headers = files.filter(f => f.path.replace(/\.[^.]+$/, '') === stem && /\.(?:h|hh|hpp|hxx)$/.test(f.path));
  const implementations = files.filter(f => f.path.replace(/\.[^.]+$/, '') === stem && /\.(?:c|cc|cpp|cxx)$/.test(f.path));
  if (headers.length === 1 && implementations.length === 1 && headers[0].eligibility === 'reviewable' && implementations[0].eligibility === 'reviewable' && file.id === implementations[0].id) edges.push({from:file.id,to:headers[0].id,reason:'cpp-header-implementation-name'});
  for (const side of ['old','new']) {
   if (side === 'old' && file.oldPath && file.oldPath !== file.path) continue;
   const text = (side === 'old' ? file.left : file.right)?.text;
   if (typeof text !== 'string' || Buffer.byteLength(text) > 256*1024 || /\/\*|\\\r?\n|R"/.test(text)) continue;
   const lines = text.split(String.fromCharCode(10));
   // Conditional/macro includes are not resolved without a build configuration.
   if (lines.some(line => /^\s*#\s*(?:if|ifdef|ifndef|elif|else|endif|define|undef)\b/.test(line))) continue;
   for (let i=0;i<lines.length;i++) {
    const match = /^\s*#\s*include\s+"([^"\\]+)"\s*(?:\/\/.*)?$/.exec(lines[i]);
    if (!match || match[1].startsWith('/') || match[1].includes(':')) continue;
    const targetPath = path.posix.normalize(path.posix.join(path.posix.dirname(file.path),match[1]));
    if (targetPath.startsWith('../') || targetPath === '..') continue;
    if (side === 'old' && files.some(f => f.oldPath && f.oldPath !== f.path && (f.oldPath === targetPath || f.path === targetPath))) continue;
    const target = byPath.get(targetPath);
    if (!target || target.id === file.id || target.eligibility !== 'reviewable' || !cpp(target.path)) continue;
    edges.push({from:file.id,to:target.id,side,line:i+1,specifier:match[1],reason:'cpp-quoted-include:'+side+':L'+(i+1)});
    if (edges.length >= 2000) return edges;
   }
  }
 }
 return edges.slice(0,2000);
}
