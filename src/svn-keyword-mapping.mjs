import {hash} from './content.mjs';
const standard=new Set(['Date','LastChangedDate','Revision','Rev','LastChangedRevision','Author','LastChangedBy','HeadURL','URL','Id','Header']);

// A line-preserving view only. Raw source remains authoritative for evidence.
export function svnKeywordMapping(text,configuration){
 if(typeof text!=='string'||typeof configuration!=='string'||Buffer.byteLength(text)>256*1024||Buffer.byteLength(configuration)>4096)throw new Error('Invalid SVN keyword mapping input');
 const enabled=new Set(configuration.trim().split(/\s+/).filter(Boolean));
 if([...enabled].some(name=>!standard.has(name)))throw new Error('Unsupported SVN custom keyword configuration');
 let replacements=0;
 const normalized=text.replace(/\$([A-Za-z][A-Za-z0-9]*)(:{1,2})([^\r\n$]*)\$/g,(literal,name,separator,value)=>{
  if(!enabled.has(name))return literal;
  if(separator!==':'||!/^ .+ $/.test(value))throw new Error('Unsupported SVN fixed-width or ambiguous keyword expansion');
  replacements++;return '$'+name+'$';
 });
 // Reject enabled malformed expansions, rather than silently offering a partial mapping.
 for(const name of enabled){
  const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  if(new RegExp('\\$'+escaped+':').test(normalized))throw new Error('Incomplete SVN keyword expansion mapping');
 }
 if(text.split('\n').length!==normalized.split('\n').length)throw new Error('SVN keyword mapping changed line identity');
 return {text:normalized,rawTextHash:hash(text),textHash:hash(normalized),replacements,lineMapping:'identity',status:'candidate-only',notice:'Line-preserving standard keyword view, not evidence of equivalent program behavior; raw source remains required. Capture must independently verify BASE contraction and keep raw evidence.'};
}
