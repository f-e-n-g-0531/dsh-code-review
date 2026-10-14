import {validateCallerScopes} from './caller-index.mjs';
import {callerCandidates} from './caller-candidates.mjs';
import {relativePath,hash} from './content.mjs';
import {isSecretPath} from './secret-path.mjs';

// Fixed revision capabilities only. All failures propagate; no worktree fallback.
export async function svnHistoryCallers(files,history,scopes,context,{index,lookup,read,signal,maxContextFiles=20,rulePaths=[]}={}) {
 const approved=validateCallerScopes(scopes);
 if(!Array.isArray(files)||files.length>200||!Array.isArray(context)||context.length>maxContextFiles||!Number.isSafeInteger(maxContextFiles)||maxContextFiles<1||maxContextFiles>20||![index,lookup,read].every(fn=>typeof fn==='function')||!Array.isArray(rulePaths)||!history||!['base','target'].every(k=>typeof history[k]==='string'&&/^(0|[1-9][0-9]*)$/.test(history[k])&&Number.isSafeInteger(Number(history[k]))))throw new Error('Invalid SVN historical caller capability or budget');
 const changed=new Set(files.map(f=>f.path)),rules=new Set(rulePaths),candidates=[],scanned=[],allProbes=new Set();
 let records=0,scanBytes=0;
 for(const [side,revision]of [['old',history.base],['new',history.target]]){
  signal?.throwIfAborted();const entries=await index(approved,revision);
  if(!Array.isArray(entries))throw new Error('Invalid SVN historical caller index');
  const seen=new Set(),sources=[];
  for(const entry of entries){
   if(++records>256)throw new Error('SVN historical caller index limit exceeded');
   const name=relativePath(entry?.path);
   if(!approved.some(scope=>name.startsWith(scope+'/'))||seen.has(name)||!['file','dir'].includes(entry.kind))throw new Error('Unsafe SVN historical caller index');
   seen.add(name);
   if(entry.kind!=='file'||changed.has(name)||rules.has(name)||isSecretPath(name)||!/\.(mjs|cjs|js|jsx|ts|tsx|c|cc|cpp|cxx|h|hh|hpp|hxx|shader|hlsl|glsl|cginc|hlsli|compute)$/i.test(name))continue;
   if(scanned.length>=128)throw new Error('SVN historical caller scan count exceeded');
   const value=await read(name,revision);signal?.throwIfAborted();
   if(typeof value?.content?.text!=='string'||value.kind!=='file'||value.source?.operativeRevision!==revision)throw new Error('Invalid fixed SVN caller body');
   const bodyBytes=value.content.bytes??Buffer.byteLength(value.content.text);
   if(!Number.isSafeInteger(bodyBytes)||bodyBytes<0||bodyBytes>256*1024||Buffer.byteLength(value.content.text)>256*1024)throw new Error('Invalid fixed SVN caller size');
   scanBytes+=bodyBytes;
   if(scanBytes>1024*1024)throw new Error('SVN historical caller scan source limit exceeded');
   const source={path:name,...value.content,svnSource:value.source,side,revision};sources.push(source);scanned.push(source);
  }
  const targets=files.map(file=>{
   const kind=side==='old'?file.oldKind:file.newKind,body=side==='old'?file.left:file.right;
   return {...file,right:kind==='file'?body:undefined,rightExists:kind==='file'&&typeof body?.text==='string'};
  });
  const requested=callerCandidates(targets,sources,[]).probePaths,present=[];
  for(const name of requested){
   signal?.throwIfAborted();allProbes.add(JSON.stringify([revision,name]));if(allProbes.size>512)throw new Error('SVN historical caller probe limit exceeded');
   const node=await lookup(name,revision);
   if(node!==null&&(!node||!['file','dir'].includes(node.kind)))throw new Error('Invalid fixed SVN caller probe');
   if(node)present.push(name); // Directories remain resolution competitors.
  }
  const plan=callerCandidates(targets,sources,present);
  for(const candidate of plan.candidates){
   const receipt={...candidate,side,revision,status:'pending'};candidates.push(receipt);
   const source=sources.find(value=>value.path===candidate.fromPath);
   let item=context.find(value=>value.path===source.path);
   if(item?.oldOnly&&side==='new'){receipt.status='blocked';receipt.reason='Explicit old-only context cannot approve target caller';continue;}
   if(!item&&context.length>=maxContextFiles){receipt.status='blocked';receipt.reason='Context file limit exceeded';continue;}
   const existing=side==='old'?item?.oldText:item?.text;
   if(existing!==undefined&&existing!==source.text)throw new Error('Fixed SVN caller context content mismatch');
   if(!item){item={path:source.path};context.push(item);}
   if(side==='new')Object.assign(item,{text:source.text,hash:source.hash,bytes:source.bytes,encoding:source.encoding,revision,svnSource:source.svnSource});
   else Object.assign(item,{oldText:source.text,oldHash:hash(source.text),oldRevision:revision,oldSvnSource:source.svnSource});
   receipt.status='captured';
  }
 }
 // Only matched sides are retained. A new-side match never approves an old body.
 for(const item of context)if(item.text===undefined&&item.oldText!==undefined)item.oldOnly=true;
 return {scopes:approved,scanned:scanned.map(({path,hash,bytes,revision,side,svnSource})=>({path,hash,bytes,revision,side,svnSource})),scannedBytes:scanBytes,records,probeCount:allProbes.size,candidates,capturedPaths:[...new Set(candidates.filter(c=>c.status==='captured').map(c=>c.fromPath))].sort(),incomplete:true,notice:'Fixed-side literal references in explicit scopes only; nonmatches scanned but not captured. Not function calls, semantic binding or complete caller coverage.'};
}
