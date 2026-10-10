import {contextCandidates} from './context-candidates.mjs';
import {svnCallerNode,svnCallerProbes} from './svn-caller-node.mjs';
import {readLocal} from './content.mjs';
// Exact local path probes only. Every body requires safe offline SVN node identity.
export async function captureSvnDependencyChain(root,files,options={}){
 const signal=AbortSignal.any([AbortSignal.timeout(30000),...(options.signal?[options.signal]:[])]),bounded={...options,signal,maxFileBytes:Math.min(options.maxFileBytes??256*1024,256*1024)};
 const visited=new Set(files.map(f=>f.path)),reserved=new Set([...(options.contextPaths??[]),...(options.rulePaths??[])]),probes=new Set(),context=[],candidates=[],nodes=[];let frontier=[...files],bytes=0,truncated=false,index;
 const limit=Math.min(options.maxContextFiles??20,20);if(new Set(options.contextPaths??[]).size>limit)throw new Error('Context file limit exceeded');
 // Explicit context remains separately selected; safe normal nodes can seed navigation.
 const explicitSeeds=[];for(const name of [...new Set(options.contextPaths??[])].sort()){
  const changed=files.find(f=>f.path===name);if(changed){if(changed.eligibility!=='reviewable'||changed.rightExists===false)throw new Error('Context path is an excluded blocked or deleted change');continue;}
  const node=await svnCallerNode(root,name,bounded),item={path:name,...await readLocal(root,name,bounded)};bytes+=item.bytes;if(bytes>1024*1024)throw new Error('SVN dependency source byte limit exceeded');nodes.push({path:name,fingerprint:node.fingerprint});explicitSeeds.push(item);visited.add(name);frontier.push({path:name,eligibility:'reviewable',right:item});
 }
 const onProbe=paths=>{for(const p of paths)probes.add(p);if(probes.size>512)throw new Error('SVN dependency lookup limit exceeded');};
 for(let depth=1;depth<=3&&frontier.length;depth++){
  for(let i=0;i<frontier.length;i+=200)contextCandidates(frontier.slice(i,i+200),[],{onProbe});index=await svnCallerProbes(root,[...probes],bounded);
  const plans=[];for(let i=0;i<frontier.length;i+=200)plans.push(contextCandidates(frontier.slice(i,i+200),index.paths));const next=[];
  for(const plan of plans){truncated ||= plan.truncated;for(const entry of plan.candidates){if(visited.has(entry.path)||reserved.has(entry.path))continue;visited.add(entry.path);const c={...entry,depth};candidates.push(c);if(candidates.length>20)throw new Error('SVN dependency candidate limit exceeded');
   if(context.length+new Set(options.contextPaths??[]).size>=limit){c.status='blocked';c.reason='Context file limit exceeded';continue;}
   try{const node=await svnCallerNode(root,entry.path,bounded),item={path:entry.path,...await readLocal(root,entry.path,bounded)};bytes+=item.bytes;if(bytes>1024*1024)throw new Error('SVN dependency source byte limit exceeded');context.push(item);nodes.push({path:item.path,fingerprint:node.fingerprint});c.status='captured';next.push({path:item.path,eligibility:'reviewable',right:item});}
   catch(error){signal.throwIfAborted();if(error.message==='SVN dependency source byte limit exceeded')throw error;c.status='blocked';c.reason=error.message;}
  }}frontier=next;
 }if(frontier.length)truncated=true;
 const verify=async()=>{for(const node of nodes)if((await svnCallerNode(root,node.path,bounded)).fingerprint!==node.fingerprint)throw new Error('SVN dependency node changed during capture');if(index&&(await svnCallerProbes(root,[...probes],bounded)).fingerprint!==index.fingerprint)throw new Error('SVN dependency resolution changed during capture');signal.throwIfAborted();};
 return {context,explicitSeeds,indexOptions:bounded,verify,autoContext:{candidates,capturedPaths:context.map(c=>c.path),truncated,maxDepth:3,sourceBytes:bytes,probeCount:probes.size,notice:'Offline safe SVN current-side literal dependencies, at most 3 layers, 512 exact probes, 20 candidates/context slots, 1MiB source and 30s including verification. Not symbol binding or complete caller coverage.'}};
}
