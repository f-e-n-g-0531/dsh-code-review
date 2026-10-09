import { contextCandidates } from './context-candidates.mjs';
import { relativePath } from './content.mjs';
import { isSecretPath } from './secret-path.mjs';

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
    for (const target of plan.candidates) if (targets.has(target.path)) candidates.push({fromPath:source.path,targetPath:target.path,reason:target.reasons[0],confidence:'navigation-only'});
  }
  const compare=(a,b)=>a<b?-1:a>b?1:0;
  return {candidates:candidates.sort((a,b)=>compare(a.fromPath,b.fromPath)||compare(a.targetPath,b.targetPath)),probePaths:[...probes].sort(),notice:'Literal module/include references only; not function calls, reachability, semantic binding or complete caller coverage.'};
}
