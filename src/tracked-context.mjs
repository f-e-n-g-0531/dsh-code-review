import { xml } from './svn.mjs';
import { checked } from './process.mjs';
import { relativePath } from './content.mjs';
export async function svnContextIndex(root, options = {}) {
 const bytes = await checked('svn',['--non-interactive','status','--xml','--verbose','--ignore-externals','--','.@'],{...options,cwd:root,maxBytes:1024*1024});
 const entries=(xml(bytes).status?.target ?? []).flatMap(t=>t.entry ?? []);
 if(entries.length>10000)throw new Error('Tracked context index limit exceeded');
 const paths=[], seen=new Set();
 for(const e of entries){const name=e['@_path'].replaceAll('\\','/');if(name==='.')continue;relativePath(name);if(seen.has(name))throw new Error('Duplicate SVN context path');seen.add(name);const s=e['wc-status'];if(s?.['@_item']==='normal'&&s['@_props']==='none'&&!['@_switched','@_copied','@_file-external','@_tree-conflicted'].some(k=>s[k]==='true'))paths.push(name);}
 // SVN may reorder XML attributes; compare canonical parsed state, not serialization.
 const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
 return {paths:paths.sort(),fingerprint:JSON.stringify(canonical([...entries].sort((a,b)=>a['@_path']<b['@_path']?-1:a['@_path']>b['@_path']?1:0)))};
}
// Index metadata only; never invokes network, diff drivers or source reads.
export async function gitContextIndex(root, options = {}) {
 let bytes;
 if(options.probePaths !== undefined){
  if(!Array.isArray(options.probePaths)||options.probePaths.length>512||new Set(options.probePaths).size!==options.probePaths.length)throw new Error('Invalid Git context probes');
  const chunks=[];let totalBytes=0;for(const name of [...options.probePaths].sort()){relativePath(name);const chunk=await checked('git',['--no-optional-locks','--literal-pathspecs','-c','core.fsmonitor=false','-c','core.untrackedCache=false','ls-files','--stage','-z','--',name],{...options,cwd:root,maxBytes:64*1024});const records=new TextDecoder('utf-8',{fatal:true}).decode(chunk).split('\0').filter(Boolean);for(const record of records)if(record.slice(record.indexOf('\t')+1)!==name)throw new Error('Git context probe expanded beyond literal path');totalBytes+=chunk.length;if(totalBytes>1024*1024)throw new Error('Tracked context index limit exceeded');chunks.push(chunk);}
  bytes=Buffer.concat(chunks);if(bytes.length>1024*1024)throw new Error('Tracked context index limit exceeded');
 }else bytes = await checked('git', ['--no-optional-locks','-c','core.fsmonitor=false','-c','core.untrackedCache=false','ls-files','--stage','-z'], {...options,cwd:root,maxBytes:1024*1024});
 const records = new TextDecoder('utf-8',{fatal:true}).decode(bytes).split('\0').filter(Boolean);
 if(records.length>10000)throw new Error('Tracked context index limit exceeded');
 const entries=new Map();
 for(const record of records){
  const match=/^(\d{6}) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/.exec(record);if(!match)throw new Error('Invalid Git context index');
  const name=relativePath(match[4]);const valid=match[3]==='0'&&['100644','100755'].includes(match[1]);
  if(entries.has(name))entries.set(name,false);else entries.set(name,valid);
 }
 return {paths:[...entries].filter(([,valid])=>valid).map(([name])=>name).sort(),fingerprint:bytes.toString('base64')};
}
