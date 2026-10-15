import {svnCallerNode} from './svn-caller-node.mjs';
import {readLocal,decode} from './content.mjs';
import {checked} from './process.mjs';
import {svnKeywordMapping} from './svn-keyword-mapping.mjs';
import {svnEolMapping} from './svn-eol-mapping.mjs';
export async function captureSvnExplicitContext(root,names,options={}){
 const signal=AbortSignal.any([AbortSignal.timeout(30000),...(options.signal?[options.signal]:[])]),bounded={...options,allowExplicitKeywords:true,signal,maxFileBytes:Math.min(options.maxFileBytes??256*1024,256*1024)};
 if(!Array.isArray(names)||names.length>20||new Set(names).size!==names.length)throw new Error('Invalid SVN explicit context selection');
 const context=[],identities=[];let bytes=0;
 for(const name of names){
  const node=await svnCallerNode(root,name,bounded),content=await readLocal(root,name,bounded);bytes+=content.bytes;if(bytes>1024*1024)throw new Error('SVN explicit context source byte limit exceeded');
  let keywordMapping;
  if(node.keywords){
   const current=svnKeywordMapping(content.text,node.keywords);
   const readBase=async(ignore)=>{const data=await checked('svn',['--non-interactive','cat',...(ignore?['--ignore-keywords']:[]),'-r','BASE','--',name+'@'],{...bounded,cwd:root,maxBytes:bounded.maxFileBytes});bytes+=data.length;if(bytes>1024*1024)throw new Error('SVN explicit context source byte limit exceeded');return decode(data);};
   const base=svnKeywordMapping((await readBase(false)).text,node.keywords),repository=await readBase(true);
   if(base.text!==repository.text)throw new Error('SVN explicit BASE keyword mapping differs from repository text');
   const {text,...metadata}=current;keywordMapping={...metadata,status:'verified-line-view',notice:'Raw working text remains evidence; BASE contraction independently verified. Keyword view is not behavioral equivalence.'};
  }
  context.push({path:name,...content,...(keywordMapping?{keywordMapping}:{}),...(node.eolStyle?{eolMapping:svnEolMapping(content.text,node.eolStyle)}:{})});identities.push({path:name,fingerprint:node.fingerprint});
 }
 const verify=async()=>{for(const node of identities)if((await svnCallerNode(root,node.path,bounded)).fingerprint!==node.fingerprint)throw new Error('SVN explicit context identity changed during capture');signal.throwIfAborted();};
 return {context,verify,options:bounded,sourceBytes:bytes};
}
