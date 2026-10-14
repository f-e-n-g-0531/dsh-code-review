import path from 'node:path';
import {relativePath} from './content.mjs';

// A successful immediate-parent listing proves absence within the visible scope.
// Access errors are propagated, not interpreted using stderr or localized text.
export function fixedSvnLookup({list,signal,maxEntries=512}={}) {
 if(typeof list!=='function'||!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>512)throw new Error('Invalid SVN historical lookup capability');
 const directories=new Map();let entries=0;
 const lookup=async(name,revision)=>{
  relativePath(name);signal?.throwIfAborted();
  if(typeof revision!=='string'||!/^(0|[1-9][0-9]*)$/.test(revision)||!Number.isSafeInteger(Number(revision)))throw new Error('Invalid SVN lookup revision');
  const parent=path.posix.dirname(name),key=JSON.stringify([revision,parent]);
  if(!directories.has(key)){
   if(parent!=='.'){
    const node=await lookup(parent,revision);
    if(!node||node.kind!=='dir')return null;
   }
   const records=await list(parent,revision);signal?.throwIfAborted();
   if(!Array.isArray(records))throw new Error('Invalid fixed SVN directory listing');
   const children=new Map();
   for(const record of records){
    if(++entries>maxEntries)throw new Error('SVN historical directory entry budget exceeded');
    if(typeof record?.name!=='string'||record.name.includes('/')||relativePath(record.name)!==record.name||!['file','dir'].includes(record.kind)||children.has(record.name))throw new Error('Invalid fixed SVN directory entry');
    children.set(record.name,{kind:record.kind});
   }
   directories.set(key,children);
  }
  return directories.get(key).get(path.posix.basename(name))??null;
 };
 return {lookup,usage:()=>({directories:directories.size,entries})};
}
