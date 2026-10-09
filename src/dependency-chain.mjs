import {contextCandidates} from './context-candidates.mjs';
import {gitContextIndex} from './tracked-context.mjs';
import {readLocal} from './content.mjs';
// Fixed-depth literal navigation, not symbol binding. Never enumerate the repository.
export async function captureDependencyChain(root,files,options={}){
 const signal=AbortSignal.any([AbortSignal.timeout(30000),...(options.signal?[options.signal]:[])]);
 const scoped={...options,maxFileBytes:Math.min(options.maxFileBytes??256*1024,256*1024),signal},probes=new Set(),visited=new Set(files.map(f=>f.path)),context=[],candidates=[];
 const reserved=new Set([...(options.contextPaths??[]),...(options.rulePaths??[])]),limit=Math.min(options.maxContextFiles??20,20);
 let frontier=files,index,bytes=0,truncated=false,depth=0;
 const onProbe=paths=>{for(const p of paths)probes.add(p);if(probes.size>512)throw new Error('Git context lookup limit exceeded');};
 for(depth=1;depth<=3&&frontier.length;depth++){
  signal.throwIfAborted();contextCandidates(frontier,[],{onProbe});
  index=await gitContextIndex(root,{...scoped,probePaths:[...probes]});
  const plan=contextCandidates(frontier,index.paths);truncated ||= plan.truncated;
  const next=[];
  for(const entry of plan.candidates){
   if(visited.has(entry.path)||reserved.has(entry.path))continue;
   visited.add(entry.path);const candidate={...entry,depth};candidates.push(candidate);
   if(candidates.length>20)throw new Error('Dependency candidate limit exceeded');
   if(context.length+new Set(options.contextPaths??[]).size>=limit){candidate.status='blocked';candidate.reason='Context file limit exceeded';continue;}
   try{
    const item={path:entry.path,...await readLocal(root,entry.path,scoped)};
    bytes+=item.bytes;if(bytes>1024*1024)throw new Error('Dependency source byte limit exceeded');
    context.push(item);candidate.status='captured';
    next.push({path:item.path,eligibility:'reviewable',right:item});
   }catch(error){signal.throwIfAborted();if(error.message==='Dependency source byte limit exceeded')throw error;candidate.status='blocked';candidate.reason=error.message;}
  }
  frontier=next;
 }
 if(frontier.length)truncated=true;
 const indexOptions={...scoped,probePaths:[...probes]};
 return {context,index,indexOptions,autoContext:{candidates,capturedPaths:context.map(c=>c.path),truncated,maxDepth:3,probeCount:probes.size,sourceBytes:bytes,notice:'Bounded current-side literal dependency navigation, depth <=3, 512 shared exact probes, 20 candidates/context slots, 1MiB source bytes and 30s through verification. Not symbol binding, caller coverage or complete definitions.'}};
}
