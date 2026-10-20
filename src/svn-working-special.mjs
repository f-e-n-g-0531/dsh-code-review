import {lstat,readlink,realpath} from 'node:fs/promises';
import path from 'node:path';
import {relativePath,readLocal,decode} from './content.mjs';
import {assertNonSecretPath} from './secret-path.mjs';
import {svnSpecialData} from './svn-special.mjs';

// Validate ancestors but never realpath/open a symbolic-link leaf or its target.
export async function readWorkingSvnSpecial(root,name,properties,options={}){
 relativePath(name);assertNonSecretPath(name);options.signal?.throwIfAborted();
 const canonical=await realpath(root);let cursor=canonical;const parts=name.split('/');
 const ancestors=[];
 for(const part of parts.slice(0,-1)){cursor=path.join(cursor,part);const stat=await lstat(cursor);if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error('SVN special ancestor must be a real directory');ancestors.push({path:cursor,dev:stat.dev,ino:stat.ino,ctimeMs:stat.ctimeMs});}
 const filename=path.join(cursor,parts.at(-1)),before=await lstat(filename);let content;
 if(before.isSymbolicLink()){
  const target=await readlink(filename,{encoding:'buffer'});if(target.length>16384)throw new Error('SVN link target byte limit exceeded');
  const bytes=Buffer.concat([Buffer.from('link '),target]);if(bytes.length>(options.maxFileBytes??256*1024))throw new Error('SVN special file size limit exceeded');
  content=decode(bytes);const after=await lstat(filename);const again=await readlink(filename,{encoding:'buffer'});
  for(const ancestor of ancestors){const now=await lstat(ancestor.path);if(now.isSymbolicLink()||!now.isDirectory()||now.dev!==ancestor.dev||now.ino!==ancestor.ino||now.ctimeMs!==ancestor.ctimeMs)throw new Error('SVN special ancestor changed during capture');}
  if(!after.isSymbolicLink()||before.ino!==after.ino||before.dev!==after.dev||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||!again.equals(target))throw new Error('SVN link changed during capture');
 }else{
  if(!before.isFile())throw new Error('SVN special working node is neither link nor regular link record');
  content=await readLocal(canonical,name,options);
 }
 options.signal?.throwIfAborted();
 return {content,special:svnSpecialData(content,properties,'file')};
}
