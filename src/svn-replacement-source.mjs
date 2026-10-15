import {sameSvnUrl} from './svn-url.mjs';
import {checked} from './process.mjs';
import {xml} from './svn.mjs';
import {decode,hash,relativePath} from './content.mjs';

// Explicit independent repository baseline; never local BASE/copy-source pristine.
export async function readReplacementSource(root,rootInfo,name,revision,options={}){
 relativePath(name);if(typeof revision!=='string'||!/^(0|[1-9][0-9]*)$/.test(revision)||!Number.isSafeInteger(Number(revision)))throw new Error('Replacement baseline requires fixed numeric revision');
 const url=rootInfo.url.replace(/\/$/,'')+'/'+name.split('/').map(encodeURIComponent).join('/'),destination=new URL(url);
 if(destination.username||destination.password||destination.search||destination.hash||!['file:','http:','https:','svn:','svn+ssh:'].includes(destination.protocol))throw new Error('Unsafe replacement baseline URL');
 if((destination.protocol!=='file:'||destination.hostname)&&options.svnReplacementAllowNetwork!==true)throw new Error('Replacement repository baseline requires explicit svnReplacementAllowNetwork');
 const at=url+'@'+revision;const run=async(args,body=false)=>checked('svn',['--non-interactive',...args,'--',at],{...options,cwd:root,maxBytes:body?options.maxFileBytes??256*1024:256*1024});
 const node=xml(await run(['info','--xml','-r',revision])).info?.entry?.[0];
 if(!sameSvnUrl(node?.url,url)||String(node['@_revision'])!==revision||node.repository?.uuid!==rootInfo.repository.uuid||!sameSvnUrl(node.repository?.root,rootInfo.repository.root)||!['file','dir'].includes(node['@_kind']))throw new Error('Replacement baseline identity or kind mismatch');
 const props=Object.create(null);for(const p of xml(await run(['proplist','--xml','--verbose','-r',revision])).properties?.target?.[0]?.property??[]){if(typeof p['@_name']!=='string'||p['@_encoding']||Object.hasOwn(props,p['@_name']))throw new Error('Unsafe replacement baseline property representation');props[p['@_name']]=p['#text']??'';}
 let descendants=[];
 if(node['@_kind']==='dir'){
  const listing=xml(await run(['list','--xml','--depth','infinity','-r',revision]));
  const lists=listing.lists?.list,one=Array.isArray(lists)?lists:[lists];
  if(one.length!==1||!one[0]||!sameSvnUrl(one[0]['@_path'],url))throw new Error('Replacement old directory listing identity mismatch');
  const seen=new Set();for(const entry of one[0].entry??[]){const child=relativePath(entry.name);if(seen.has(child)||!['file','dir'].includes(entry['@_kind']))throw new Error('Invalid replacement old descendant');seen.add(child);if(seen.size>200)throw new Error('Replacement old descendant count limit exceeded');descendants.push({path:name+'/'+child,kind:entry['@_kind']});}
 }
 const content=node['@_kind']==='dir'?decode(Buffer.alloc(0)):decode(await run(['cat','--ignore-keywords','-r',revision],true));
 return {content,props,kind:node['@_kind'],descendants,source:{repositoryUuid:rootInfo.repository.uuid,url,pegRevision:revision,operativeRevision:revision,kind:node['@_kind'],descendantHash:hash(JSON.stringify(descendants)),hash:content.hash,textHash:hash(content.text),propertyHash:hash(JSON.stringify(Object.entries(props).sort()))}};
}
