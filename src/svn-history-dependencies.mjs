import {contextCandidates} from './context-candidates.mjs';
import {relativePath,hash} from './content.mjs';
import {isSecretPath} from './secret-path.mjs';

// Injected fixed-revision capabilities must verify UUID/URL/revisions themselves.
// A null lookup means proven absence, never a swallowed read/authentication error.
export async function svnHistoryDependencies(files, history, context, {lookup, read, signal, maxContextFiles=20, rulePaths=[]}={}) {
 if(typeof lookup!=='function'||typeof read!=='function'||!Array.isArray(files)||files.length>200||!Array.isArray(context)||!Number.isSafeInteger(maxContextFiles)||maxContextFiles<1||maxContextFiles>20||context.length>maxContextFiles||!Array.isArray(rulePaths))throw new Error('Invalid SVN dependency capabilities or budget');
 const reserved=new Set(rulePaths);for(const name of reserved)relativePath(name);
 if(!history||!['base','target'].every(key=>typeof history[key]==='string'&&/^(0|[1-9][0-9]*)$/.test(history[key])&&Number.isSafeInteger(Number(history[key]))))throw new Error('Invalid fixed SVN dependency revisions');
 const cache={old:new Map(),new:new Map()},visited={old:new Set(),new:new Set()},candidates=new Map();
 let probes=0,bytes=0,truncated=false;
 const probe=async(side,name)=>{
  relativePath(name);signal?.throwIfAborted();
  if(!cache[side].has(name)){
   if(++probes>512)throw new Error('SVN historical dependency probe limit exceeded');
   const node=await lookup(name,side==='old'?history.base:history.target,side);
   if(node!==null&&(!node||!['file','dir'].includes(node.kind)))throw new Error('Invalid SVN historical dependency probe result');
   cache[side].set(name,node);
  }
  return cache[side].get(name);
 };
 const charge=text=>{bytes+=Buffer.byteLength(text);if(bytes>1024*1024)throw new Error('SVN historical dependency source limit exceeded');};
 const nextSource=(name,text)=>({path:name,eligibility:'reviewable',right:{text}});
 let frontier={old:[],new:[]};
 for(const file of files){
  if(file.eligibility!=='reviewable'||file.kind==='dir'&&file.path==='.')continue;
  for(const side of ['old','new']){
   if(file.specialData?.[side])continue;
   const kind=side==='old'?file.oldKind:file.newKind,text=(side==='old'?file.left:file.right)?.text;
   if(kind==='file'&&typeof text==='string'){visited[side].add(file.path);frontier[side].push(nextSource(file.path,text));}
  }
 }
 for(const item of context)for(const side of ['old','new']){
  const text=side==='old'?item.oldText:item.text;if(typeof text==='string'){visited[side].add(item.path);frontier[side].push(nextSource(item.path,text));charge(text);}
 }
 for(let depth=1;depth<=3;depth++){
  const next={old:[],new:[]};
  for(const side of ['old','new']){
   signal?.throwIfAborted();
   const requested=new Set();
   for(let i=0;i<frontier[side].length;i+=200)contextCandidates(frontier[side].slice(i,i+200),[],{onProbe:names=>names.forEach(name=>requested.add(name))});
   for(const name of requested)await probe(side,name);
   const present=[...cache[side]].filter(([,node])=>node!==null).map(([name])=>name);
   for(let i=0;i<frontier[side].length;i+=200){
    const plan=contextCandidates(frontier[side].slice(i,i+200),present,{includeChanged:true});truncated ||= plan.truncated;
    for(const entry of plan.candidates){
     if(visited[side].has(entry.path))continue;visited[side].add(entry.path);
     let candidate=candidates.get(entry.path);
     if(!candidate){if(candidates.size>=20)throw new Error('SVN historical dependency candidate limit exceeded');candidate={...entry,depth,sides:[]};candidates.set(entry.path,candidate);}
     const receipt={side,revision:side==='old'?history.base:history.target,status:'pending'};candidate.sides.push(receipt);
     if(reserved.has(entry.path)){receipt.status='blocked';receipt.reason='Rule path cannot become dependency context';continue;}
     const changed=files.find(file=>file.path===entry.path);
     if(changed){
      const kind=side==='old'?changed.oldKind:changed.newKind,text=(side==='old'?changed.left:changed.right)?.text;
      if(changed.eligibility!=='reviewable'||changed.specialData?.[side]||kind!=='file'||typeof text!=='string'){receipt.status='blocked';receipt.reason='Dependency conflicts with excluded blocked or unavailable change';continue;}
      receipt.status='reused-change';next[side].push(nextSource(entry.path,text));continue;
     }
     if(isSecretPath(entry.path)){receipt.status='blocked';receipt.reason='Credential dependency excluded';continue;}
     if(cache[side].get(entry.path)?.kind!=='file'){receipt.status='blocked';receipt.reason='Dependency is not a file';continue;}
     let item=context.find(value=>value.path===entry.path);
     // Explicit old-only context never grants target text, even if navigation sees it.
     if(item?.oldOnly&&side==='new'){receipt.status='blocked';receipt.reason='Explicit old-only context cannot approve target side';continue;}
     if(!item&&context.length>=maxContextFiles){receipt.status='blocked';receipt.reason='Context file limit exceeded';continue;}
     const presentText=side==='old'?item?.oldText:item?.text;
     if(typeof presentText==='string'){receipt.status='reused-context';next[side].push(nextSource(entry.path,presentText));continue;}
     const value=await read(entry.path,receipt.revision,side);signal?.throwIfAborted();
     if(typeof value?.content?.text!=='string'||!value.source||value.source.operativeRevision!==receipt.revision)throw new Error('Invalid fixed SVN dependency body');
     charge(value.content.text);
     if(!item){item={path:entry.path};context.push(item);}
     if(side==='new')Object.assign(item,value.content,{revision:history.target,svnSource:value.source});
     else Object.assign(item,{oldText:value.content.text,oldHash:hash(value.content.text),oldRevision:history.base,oldSvnSource:value.source});
     receipt.status='captured';next[side].push(nextSource(entry.path,value.content.text));
    }
   }
  }
  frontier=next;
  if(!next.old.length&&!next.new.length)break;
  if(depth===3)truncated=true;
 }
 for(const candidate of candidates.values())candidate.status=candidate.sides.some(side=>side.status==='blocked')?'blocked':candidate.sides.some(side=>side.status==='captured')?'captured':'reused-context';
 for(const item of context)if(item.text===undefined&&item.oldText!==undefined)item.oldOnly=true;
 return {candidates:[...candidates.values()].sort((a,b)=>a.path.localeCompare(b.path)),capturedPaths:[...candidates].filter(([,c])=>c.sides.some(s=>s.status==='captured')).map(([name])=>name).sort(),probeCount:probes,sourceBytes:bytes,maxDepth:3,truncated,notice:'Fixed side/revision literal navigation only; no current worktree, semantic binding or complete dependency coverage.'};
}
