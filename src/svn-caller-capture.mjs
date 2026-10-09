import {svnCallerIndex} from './svn-caller-index.mjs';
import {svnCallerNode,svnCallerProbes} from './svn-caller-node.mjs';

import {callerCandidates} from './caller-candidates.mjs';
import {readLocal} from './content.mjs';
import {isSecretPath} from './secret-path.mjs';

// Called only by preview capture, never by a model retrieval request.
export async function captureSvnCallers(root, files, scopes, options={}) {
 const deadline=AbortSignal.timeout(30000);
 const signal=options.signal?AbortSignal.any([options.signal,deadline]):deadline;
 const bounded={...options,signal,maxFileBytes:Math.min(options.maxFileBytes??256*1024,256*1024)};
 const index=await svnCallerIndex(root,scopes,bounded);
 const changed=new Set(files.flatMap(f=>[f.path,...(f.oldPath?[f.oldPath]:[])]));
 const rules=new Set(options.rulePaths??[]),scanned=[],skipped=[];
 let scannedBytes=0;
 for(const name of index.paths){
  signal.throwIfAborted();
  if(changed.has(name)||rules.has(name)||isSecretPath(name)) {skipped.push({path:name,reason:'Excluded from caller discovery'});continue;}
  if(!/\.(mjs|cjs|js|jsx|ts|tsx|c|cc|cpp|cxx|h|hh|hpp|hxx|shader|hlsl|glsl|cginc|hlsli|compute)$/i.test(name)){skipped.push({path:name,reason:'Unsupported caller language'});continue;}
  if(scanned.length>=128)throw new Error('Caller scan file limit exceeded');
  // Read failures are fatal: unread bytes are not negative search evidence.
  const identity=await svnCallerNode(root,name,bounded);
  const content=await readLocal(root,name,bounded);
  scannedBytes+=content.bytes;
  if(scannedBytes>1024*1024)throw new Error('Caller scan byte limit exceeded');
  scanned.push({path:name,...content,nodeFingerprint:identity.fingerprint,revision:identity.revision});
 }
 const requested=callerCandidates(files,scanned,[]).probePaths;
 const probes=await svnCallerProbes(root,requested,bounded);
 const plan=callerCandidates(files,scanned,probes.paths);
 let verifiedBytes=0;
 const verify=async()=>{
 for(const source of scanned){
  const identity=await svnCallerNode(root,source.path,bounded);
  if(identity.fingerprint!==source.nodeFingerprint)throw new Error('SVN caller node changed during capture');
  const again=await readLocal(root,source.path,bounded);verifiedBytes+=again.bytes;
  if(verifiedBytes>2*1024*1024)throw new Error('Caller verification byte limit exceeded');
  if(again.hash!==source.hash)throw new Error('Caller scan source changed during capture');
 }
 if((await svnCallerIndex(root,scopes,bounded)).fingerprint!==index.fingerprint)throw new Error('Caller index changed during capture');
 if((await svnCallerProbes(root,requested,bounded)).fingerprint!==probes.fingerprint)throw new Error('Caller resolution changed during capture');
 signal.throwIfAborted();
 };
 await verify();
 const paths=new Set(plan.candidates.map(c=>c.fromPath));
 return {verify,context:scanned.filter(s=>paths.has(s.path)),discovery:{scopes:index.scopes,indexFingerprint:index.fingerprint,probeFingerprint:probes.fingerprint,scanned:scanned.map(({path,hash,bytes,nodeFingerprint,revision})=>({path,hash,bytes,nodeFingerprint,revision})),scannedBytes,skipped,candidates:plan.candidates,notice:plan.notice,incomplete:true,limitations:['Only supported literal references inside approved scopes were searched; no complete caller or semantic coverage.']}};
}
