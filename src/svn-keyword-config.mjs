// Native SVN separates keyword definitions using ASCII whitespace, not shell quotes.
export function keywordConfigurationTokens(configuration){
 if(typeof configuration!=='string'||Buffer.byteLength(configuration)>4096)throw new Error('Invalid SVN keyword configuration');
 if(configuration.includes(String.fromCharCode(34))||configuration.includes(String.fromCharCode(39)))throw new Error('Quoted SVN keyword configurations are unsupported; use %_ for a space');
 if(/[\x00-\x08\x0e-\x1f\x7f]/.test(configuration))throw new Error('Control character in SVN keyword configuration');
 if(configuration.includes(String.fromCharCode(92)))throw new Error('Unquoted escape in SVN keyword configuration');
 const tokens=configuration.split(/[ \t\r\n\v\f]+/).filter(Boolean);
 if(tokens.length>100)throw new Error('SVN keyword configuration token limit exceeded');
 return tokens;
}
