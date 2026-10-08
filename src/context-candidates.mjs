import path from 'node:path';
import {relativePath} from './content.mjs';
// Navigation only over caller-supplied tracked regular paths; no reads or authority.
export function contextCandidates(files, trackedPaths, {maxCandidates=20,onProbe}={}) {
 if(!Array.isArray(files)||files.length>200||!Array.isArray(trackedPaths)||trackedPaths.length>10000||!Number.isSafeInteger(maxCandidates)||maxCandidates<1||maxCandidates>20)throw new Error('Invalid context candidate limit');
 const tracked=new Set();for(const p of trackedPaths){relativePath(p);if(tracked.has(p))throw new Error('Duplicate tracked path');tracked.add(p);}
 const changed=new Set(files.flatMap(f=>[f.path,...(f.oldPath?[f.oldPath]:[])]));
 const found=new Map();const add=(p,from,reason)=>{if(!tracked.has(p)||changed.has(p))return;if(!found.has(p))found.set(p,{path:p,fromPaths:[],reasons:[],confidence:'navigation-only'});const v=found.get(p);if(!v.fromPaths.includes(from))v.fromPaths.push(from);if(!v.reasons.includes(reason))v.reasons.push(reason);};
 for(const f of files){
  relativePath(f.path);if(f.eligibility!=='reviewable'||f.rightExists===false)continue;
  const text=f.right?.text;if(typeof text!=='string'||Buffer.byteLength(text)>256*1024)continue;
  if(text.includes('/*')||text.includes(String.fromCharCode(96))||text.includes('R"')||/\\\r?\n/.test(text))continue;
  const cpp=/\.(c|cc|cpp|cxx|h|hh|hpp|hxx|shader|hlsl|glsl|cginc|hlsli|compute)$/i.test(f.path),js=/\.(mjs|cjs|js|jsx|ts|tsx)$/i.test(f.path);
  if(cpp&&/^\s*#\s*(if|ifdef|ifndef|elif|else|define|undef)\b/m.test(text))continue;
  for(const line of text.split('\n')){
   const match=cpp?/^\s*#\s*include\s*"([^"\\]+)"\s*(?:\/\/.*)?$/.exec(line):js?/^\s*(?:import\s+(?:(?:[^'";]+)\s+from\s+)?|export\s+(?:[^'";]+)\s+from\s+)(['"])([^'"\\]+)\1\s*;?\s*(?:\/\/.*)?$/.exec(line):null;
   if(!match)continue;const spec=cpp?match[1]:match[2];if(!cpp&&!/^\.\.?\//.test(spec))continue;
   const target=path.posix.normalize(path.posix.join(path.posix.dirname(f.path),spec));try{relativePath(target);}catch{continue;}
   const candidates=js&&!path.posix.extname(target)?[target,...['.mjs','.cjs','.js','.jsx','.ts','.tsx'].flatMap(e=>[target+e,target+'/index'+e])]:[target];
   onProbe?.(candidates);
   const matches=candidates.filter(p=>tracked.has(p));if(matches.length===1)add(matches[0],f.path,cpp?'literal-relative-include':'literal-relative-import');
  }
 }
 const candidates=[...found.values()].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);return {candidates:candidates.slice(0,maxCandidates),truncated:candidates.length>maxCandidates,notice:'Only direct current-side import/include navigation. Not caller coverage, semantic binding or historical context. No untracked, recursive or filesystem search.'};
}
