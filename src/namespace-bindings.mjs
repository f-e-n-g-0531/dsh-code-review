import {uniqueApprovedDeclarations} from './import-bindings.mjs';
// Pure syntax navigation over already approved text; no inferred instance type.
export function namespaceImportBindings(lines, importLine, targetText) {
 if(!Array.isArray(lines)||lines.length>20000||typeof targetText!=='string')return [];
 const text=lines.join('\n');
 // Reject escape-normalized names and JSX-like lexical regions without a parser.
 if (/[\\<>]/.test(text) || /[\\<>]/.test(targetText)) return [];
 if(Buffer.byteLength(text)>256*1024||text.includes('/*')||text.includes(String.fromCharCode(96))||/\\\r?\n/.test(text))return [];
 const match=/^\s*import\s+\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s+(['"])[^'"\\]+\2\s*;?\s*(?:\/\/.*)?$/.exec(lines[importLine-1]);
 if(!match)return [];
 const local=match[1],escaped=local.replaceAll('$','\\$'),token=new RegExp('(^|[^A-Za-z0-9_$])'+escaped+'(?=[^A-Za-z0-9_$]|$)','g');
 const pattern=new RegExp('^\\s*(?:await\\s+)?'+escaped+'\\.([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\([^();"\x27/]*\\)\\s*;?\\s*$');
 const calls=[];
 for(let i=0;i<lines.length;i++){
  if(i+1===importLine)continue;
  const occurrences=[...lines[i].matchAll(token)];if(!occurrences.length)continue;
  const call=pattern.exec(lines[i]);
  // Other occurrences may mutate, shadow, pass, destructure or escape the namespace.
  if(!call||occurrences.length!==1)return [];
  if(calls.length>=20)return [];
  calls.push({member:call[1],callLine:i+1});
 }
 const targets=targetText.split('\n'),result=[];
 for(const call of calls){const declarations=uniqueApprovedDeclarations(targets,call.member);if(declarations.length===1)result.push({imported:call.member,local,member:call.member,importLine,callLine:call.callLine,declarationLine:declarations[0].number,declarationKind:declarations[0].kind,confidence:'namespace-member-syntax-only'});}
 return result;
}
