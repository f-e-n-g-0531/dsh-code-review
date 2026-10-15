// Bounded quoting tokenizer, not a shell parser. Never executes configuration.
export function keywordConfigurationTokens(configuration){
 if(typeof configuration!=='string'||Buffer.byteLength(configuration)>4096)throw new Error('Invalid SVN keyword configuration');
 if(configuration.includes(String.fromCharCode(34))||configuration.includes(String.fromCharCode(39)))throw new Error('Quoted SVN keyword configurations are not supported by verified native token semantics; use %_ for a space');
 const tokens=[];let token='',quote=null,started=false;
 for(let i=0;i<configuration.length;i++){
  const c=configuration[i];
  if(c==='\0'||c==='\r'||c==='\n'||c.charCodeAt(0)<32&&c!=='\t')throw new Error('Control character in SVN keyword configuration');
  if(quote){if(c===quote){quote=null;}else if(c==='\\'){const next=configuration[++i];if(next!==quote&&next!=='\\')throw new Error('Unsupported escape in SVN keyword configuration');token+=next;}else token+=c;started=true;continue;}
  if(c==='\"'||c==="'"){quote=c;started=true;continue;}
  if(/\s/.test(c)){if(started){tokens.push(token);token='';started=false;}continue;}
  if(c==='\\')throw new Error('Unquoted escape in SVN keyword configuration');
  token+=c;started=true;
 }
 if(quote)throw new Error('Unterminated SVN keyword configuration quote');
 if(started)tokens.push(token);
 if(tokens.length>100||tokens.some(t=>!t))throw new Error('Invalid SVN keyword configuration token count or empty token');
 return tokens;
}
