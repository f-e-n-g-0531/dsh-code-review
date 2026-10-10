import {contextCandidates} from './context-candidates.mjs';
import {checked} from './process.mjs';
import {decode,hash,relativePath} from './content.mjs';
import {assertNonSecretPath} from './secret-path.mjs';
// Immutable object reads only. Both version sides share every navigation budget.
export async function captureHistoryDependencyChain(root,files,history,context,options={}){
 const signal=AbortSignal.any([AbortSignal.timeout(30000),...(options.signal?[options.signal]:[])]);
 const bounded={...options,cwd:root,signal},probes=new Set(),visited={old:new Set(files.map(f=>f.path)),new:new Set(files.map(f=>f.path))};
 const maps={old:new Map(),new:new Map()},candidates=new Map(),reserved=new Set([...(options.rulePaths??[]),...(options.oldContextPaths??[]),...(options.contextPaths??[])]);let bytes=0,truncated=false;
 const regular=e=>e?.type==='blob'&&['100644','100755'].includes(e.mode);
 const git=(args,maxBytes=1024*1024)=>checked('git',['--no-optional-locks','--literal-pathspecs',...args],{...bounded,maxBytes});
 const lookup=async(side,paths)=>{const revision=side==='old'?history.base:history.target;if(!revision)return;for(const name of paths){relativePath(name);if(maps[side].has(name))continue;
  const records=new TextDecoder('utf-8',{fatal:true}).decode(await git(['ls-tree','-z','--full-tree',revision,'--',name])).split(String.fromCharCode(0)).filter(Boolean);let entry=null;
  for(const record of records){const m=/^(\d{6}) (blob|commit|tree) ([a-f0-9]+)\t([\s\S]+)$/.exec(record);if(!m||m[4]!==name)throw new Error('Invalid historical path lookup');entry={mode:m[1],type:m[2],oid:m[3]};}maps[side].set(name,entry);
 }};
 const read=async(side,name)=>{assertNonSecretPath(name);const entry=maps[side].get(name);if(!regular(entry))throw new Error('Historical dependency not a regular blob');const value=decode(await git(['cat-file','blob',entry.oid],Math.min(options.maxFileBytes??256*1024,256*1024)));bytes+=value.bytes;if(bytes>1024*1024)throw new Error('Historical dependency source byte limit exceeded');return value;};
 let frontier={old:files.map(f=>({...f,right:f.left,rightExists:!!f.left})),new:[...files]};
 for(const item of context){for(const side of ['old','new']){const text=side==='old'?item.oldText:item.text;if(text===undefined)continue;visited[side].add(item.path);frontier[side].push({path:item.path,eligibility:'reviewable',right:{text}});bytes+=Buffer.byteLength(text);}}
 if(bytes>1024*1024)throw new Error('Historical dependency source byte limit exceeded');
 for(let depth=1;depth<=3;depth++){
  const next={old:[],new:[]},scheduled={old:new Set(),new:new Set()};let any=false;
  for(const side of ['new','old']){if(!frontier[side].length||(side==='old'&&!history.base))continue;any=true;
   const onProbe=paths=>{for(const p of paths)probes.add(p);if(probes.size>512)throw new Error('Historical context lookup limit exceeded');};
   for(let i=0;i<frontier[side].length;i+=200)contextCandidates(frontier[side].slice(i,i+200),[],{onProbe});
   await lookup(side,[...probes]);const paths=[...maps[side]].filter(([,e])=>e).map(([p])=>p),plans=[];
   for(let i=0;i<frontier[side].length;i+=200)plans.push(contextCandidates(frontier[side].slice(i,i+200),paths,{includeChanged:true}));
   for(const plan of plans){truncated ||= plan.truncated;for(const entry of plan.candidates){
    const changed=files.find(f=>f.path===entry.path);
    if(changed){if(side!=='old'||changed.rawStatus!=='D')continue;}
    if(reserved.has(entry.path))continue;
    if(!changed&&visited[side].has(entry.path)){const existing=candidates.get(entry.path);if(existing&&!existing.sourceSides.includes(side))existing.sourceSides.push(side);continue;}visited[side].add(entry.path);
    let c=candidates.get(entry.path);if(!c){if(candidates.size>=20)throw new Error('Historical dependency candidate limit exceeded');c={...entry,depth,sourceSides:[]};candidates.set(entry.path,c);}if(!c.sourceSides.includes(side))c.sourceSides.push(side);
    try{
     if(changed){if(changed.eligibility!=='reviewable'||!changed.left)throw new Error('Old dependency conflicts with excluded blocked or absent old change');c.status='reused-changed-old';continue;}
     let item=context.find(v=>v.path===entry.path);if(!item&&context.length>=Math.min(options.maxContextFiles??20,20))throw new Error('Context file limit exceeded');
     await lookup('new',[entry.path]);await lookup('old',[entry.path]);
     // Preserve direct-context compatibility: regular target and baseline bodies are approved together.
     if(!item){item={path:entry.path};if(regular(maps.new.get(entry.path))){const value=await read('new',entry.path);Object.assign(item,value,{revision:history.target});}
      if(regular(maps.old.get(entry.path))){const value=await read('old',entry.path);Object.assign(item,{oldText:value.text,oldHash:hash(value.text),oldBlobOid:maps.old.get(entry.path).oid,oldRevision:history.base});}
      if(item.text===undefined){if(item.oldText===undefined)throw new Error('Historical dependency not a regular blob');item.oldOnly=true;}context.push(item);
     }
     c.status='captured';for(const s of ['old','new']){const text=s==='old'?item.oldText:item.text;if(text!==undefined&&!scheduled[s].has(item.path)&&(!visited[s].has(item.path)||s===side)){visited[s].add(item.path);scheduled[s].add(item.path);next[s].push({path:item.path,eligibility:'reviewable',right:{text}});}}
    }catch(error){signal.throwIfAborted();if(error.message==='Historical dependency source byte limit exceeded')throw error;c.status='blocked';c.reason=error.message;}
   }}
  }
  frontier=next;if(!any)break;if(depth===3&&(next.old.length||next.new.length))truncated=true;
 }
 signal.throwIfAborted();const ordered=[...candidates.values()].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 return {candidates:ordered,capturedPaths:ordered.filter(c=>c.status==='captured').map(c=>c.path),truncated,maxDepth:3,sourceBytes:bytes,probeCount:probes.size,base:history.base,target:history.target,notice:'Bounded baseline/target literal dependency chains, shared 3 layers, 512 paths, 20 candidates/context slots, 1MiB source and 30s. No worktree reads, semantic binding or complete caller coverage.'};
}
