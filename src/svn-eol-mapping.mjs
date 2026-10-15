import {hash} from './content.mjs';

// Keep raw text as evidence. LF view is metadata only, never a source replacement.
export function svnEolMapping(text,style=null){
 if(typeof text!=='string'||Buffer.byteLength(text)>256*1024||!(style===null||['native','LF','CRLF','CR'].includes(style)))throw new Error('Unsupported SVN EOL mapping input or style');
 let crlf=0,lf=0,cr=0;
 for(let i=0;i<text.length;i++){
  if(text[i]==='\r'){if(text[i+1]==='\n'){crlf++;i++;}else cr++;}
  else if(text[i]==='\n')lf++;
 }
 const normalized=text.replace(/\r\n|\r/g,'\n');
 return {rawTextHash:hash(text),lfViewHash:hash(normalized),style,counts:{crlf,lf,cr},mixed:[crlf,lf,cr].filter(Boolean).length>1,lineMapping:cr?'not-identity-for-LF-evidence':'identity',notice:'Hashes describe decoded text encoded as UTF-8, not original source bytes. LF-view hash only; raw text and raw evidence line numbering remain authoritative. Lone CR changes LF line boundaries; do not use normalized line numbers. Newline-only differences do not independently prove a defect or runtime equivalence.'};
}
