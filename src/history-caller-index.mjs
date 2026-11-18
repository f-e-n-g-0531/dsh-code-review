import {checked} from './process.mjs';
import {relativePath,hash} from './content.mjs';
import {validateCallerScopes} from './caller-index.mjs';
import {lookupGitTreePaths} from './git-tree-lookup.mjs';
import {measureSnapshotCommand} from './snapshot-capture-metrics.mjs';
const oidPattern=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
function revision(value){if(typeof value!=='string'||!oidPattern.test(value))throw new Error('Historical caller index requires fixed commit OID');}
const maxCommandBytes=64*1024;
const git=(root,args,options)=>measureSnapshotCommand(() => checked('git',['--no-optional-locks',...args],{...options,cwd:root,maxBytes:maxCommandBytes}),'tree');
function records(chunk){const text=new TextDecoder('utf-8',{fatal:true}).decode(chunk);if(text&&!text.endsWith('\0'))throw new Error('Incomplete historical caller index');return text.split('\0').filter(Boolean).map(record=>{const m=/^(\d{6}) (blob|tree|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/.exec(record);if(!m)throw new Error('Invalid historical caller record');return {mode:m[1],type:m[2],oid:m[3],path:relativePath(m[4])};});}
// Directory scopes only. No complete tree enumeration and no worktree/index reads.
export async function historyCallerIndex(root,commit,scopes,options={}){revision(commit);const approved=validateCallerScopes(scopes),chunks=[],entries=[];let bytes=0,count=0;for(const scope of approved){const chunk=await git(root,['--literal-pathspecs','ls-tree','-r','-z',commit,'--',scope],options);bytes+=chunk.length;if(bytes>64*1024)throw new Error('Historical caller index byte limit exceeded');for(const entry of records(chunk)){if(++count>256)throw new Error('Historical caller index path limit exceeded');if(!entry.path.startsWith(scope+'/'))throw new Error('Historical caller scope is not a directory or escaped scope');entries.push(entry);}chunks.push(Buffer.from(scope+'\0'),chunk);}return {commit,scopes:approved,entries:entries.filter(e=>e.type==='blob'&&['100644','100755'].includes(e.mode)).sort((a,b)=>a.path<b.path?-1:1),fingerprint:hash(Buffer.concat([Buffer.from(commit+'\0'),...chunks])),records:count,bytes};}
// A tree, link or submodule remains a resolution competitor, never a body grant.
export async function historyCallerProbes(root,commit,paths,options={}){
  revision(commit);
  if(!Array.isArray(paths)||paths.length>512||new Set(paths).size!==paths.length)throw new Error('Invalid historical caller probes');
  const signal=options.signal,ordered=[...paths].sort(),entries=new Map();
  const chunks=[Buffer.from(commit+'\0')],existing=[];
  let bytes=0;
  await lookupGitTreePaths(commit,entries,ordered,async args=>{
    const chunk=await git(root,args,options);
    bytes+=chunk.length;
    if(bytes>1024*1024)throw new Error('Historical caller probe metadata limit exceeded');
    if(chunk.length&&chunk.at(-1)!==0)throw new Error('Incomplete historical caller index');
    return chunk;
  },{signal,maxBytes:maxCommandBytes,errorMessage:'Invalid historical caller probe record or escaped exact path'});
  if(ordered.length)signal?.throwIfAborted();
  for(const name of ordered){
    chunks.push(Buffer.from(name+'\0'));
    const entry=entries.get(name);
    if(!entry)continue;
    existing.push(name);
    // Rebuild the prior sorted path + single-path ls-tree record stream, independent of batching.
    chunks.push(Buffer.from(entry.mode+' '+entry.type+' '+entry.oid+'\t'+name+'\0'));
  }
  return {commit,paths:existing,fingerprint:hash(Buffer.concat(chunks)),bytes};
}
