import { contextCandidates } from './context-candidates.mjs';
import { directImportBindings } from './import-bindings.mjs';
import { importedCallSites, indexStandaloneCalls } from './import-call-sites.mjs';
import { relativePath } from './content.mjs';
import { isSecretPath } from './secret-path.mjs';
import path from 'node:path';
const importExtensions=['.mjs','.cjs','.js','.jsx','.ts','.tsx'];
// Approved caller body plus approved target text only; no additional reads.
function callerBindings(fromPath, targetPath, scannedText, targetText) {
 if (typeof scannedText !== 'string' || typeof targetText !== 'string') return [];
 const lines = scannedText.split(String.fromCharCode(10)), callIndex = indexStandaloneCalls(lines), result = [];
 for (let i = 0; i < lines.length; i++) {
  const match = /^\s*(?:import\s+(?:(?:[^'";]+)\s+from\s+)?|export\s+(?:[^'";]+)\s+from\s+)(['"])([^'"\\]+)\1\s*;?\s*(?:\/\/.*)?$/.exec(lines[i]);
  if (!match || !(match[2].startsWith('./') || match[2].startsWith('../'))) continue;
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), match[2]));
  try { relativePath(target); } catch { continue; }
  const candidates = path.posix.extname(target) ? [target] : [target, ...importExtensions.map(ext => target + ext), ...importExtensions.map(ext => target + '/index' + ext)];
  if (!candidates.includes(targetPath)) continue;
  result.push(...directImportBindings(lines, i + 1, importedCallSites(lines, i + 1, callIndex), targetText));
 }
 return result.slice(0, 20);
}

// Pure reverse navigation; resolutionPaths must contain every competitor.
export function callerCandidates(files, scanned, resolutionPaths) {
  if (!Array.isArray(files) || files.length > 200 || !Array.isArray(scanned) || scanned.length > 128 || !Array.isArray(resolutionPaths) || resolutionPaths.length > 512) throw new Error('Caller navigation limit exceeded');
  for (const name of resolutionPaths) relativePath(name);
  const changed = new Set(), targets = new Set();
  for (const file of files) {
    relativePath(file.path); changed.add(file.path);
    if (file.oldPath) { relativePath(file.oldPath); changed.add(file.oldPath); }
    if (file.eligibility === 'reviewable' && file.rightExists !== false && !isSecretPath(file.path)) targets.add(file.path);
  }
  const candidates = [], probes = new Set(), seen = new Set();
  for (const source of scanned) {
    relativePath(source.path);
    if (seen.has(source.path)) throw new Error('Duplicate caller source');
    seen.add(source.path);
    if (changed.has(source.path) || isSecretPath(source.path)) continue;
    if (!/\.(mjs|cjs|js|jsx|ts|tsx|c|cc|cpp|cxx|h|hh|hpp|hxx|shader|hlsl|glsl|cginc|hlsli|compute)$/i.test(source.path)) continue;
    if (typeof source.text !== 'string' || Buffer.byteLength(source.text) > 256 * 1024) throw new Error('Invalid caller source content');
    const plan = contextCandidates([{path:source.path,eligibility:'reviewable',right:{text:source.text}}], resolutionPaths, {onProbe:paths=>{
      for (const name of paths) probes.add(name);
      if (probes.size > 512) throw new Error('Caller resolution probe limit exceeded');
    }});
    if (plan.truncated) throw new Error('Caller navigation result limit exceeded');
    for (const target of plan.candidates) if (targets.has(target.path)) { const bindings=callerBindings(source.path,target.path,source.text,files.find(f=>f.path===target.path)?.right?.text); candidates.push({fromPath:source.path,targetPath:target.path,reason:target.reasons[0],confidence:'navigation-only',...(bindings.length?{bindings}:{})}); }
  }
  const compare=(a,b)=>a<b?-1:a>b?1:0;
  return {candidates:candidates.sort((a,b)=>compare(a.fromPath,b.fromPath)||compare(a.targetPath,b.targetPath)),probePaths:[...probes].sort(),notice:'Literal module/include references only; not function calls, reachability, semantic binding or complete caller coverage.'};
}
