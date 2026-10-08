// Pure, single-attempt exact correction. Never searches another file or source side.
export function correctAnchor(raw, file, changes, {signal}={}) {
 signal?.throwIfAborted();const a=raw?.anchor;
 const result=(status,reason)=>({status,reason,originalCandidate:structuredClone(raw)});
 if(!raw||raw.fileId!==file.id||a?.kind!=='line'||!['old','new'].includes(a.side)||!Number.isSafeInteger(a.start)||!Number.isSafeInteger(a.end)||a.start<1||a.end<a.start||typeof a.snippet!=='string'||!a.snippet.trim()||a.snippet.length>8000)return result('not-applicable','invalid-anchor');
 const text=(a.side==='old'?file.left:file.right)?.text;if(typeof text!=='string'||Buffer.byteLength(text)>256*1024)return result('not-applicable','source-limit');
 const source=text.replaceAll('\r\n','\n').split('\n'),snippet=a.snippet.replaceAll('\r\n','\n').split('\n');
 if(source.slice(a.start-1,a.end).join('\n')===snippet.join('\n'))return result('unchanged','already-exact');
 if(changes?.status!=='changed'||changes.precision!=='exact'||!Array.isArray(raw.attribution?.editIds)||!raw.attribution.editIds.length)return result('rejected','missing-exact-edit');
 const edits=changes.edits.filter(e=>raw.attribution.editIds.includes(e.id));if(edits.length!==raw.attribution.editIds.length)return result('rejected','unknown-or-duplicate-edit');
 // Bound CPU even for a long multiline snippet; no silent partial search acceptance.
 if(source.length*snippet.length>2000000)return result('rejected','search-work-limit');
 let match;for(let i=0;i+snippet.length<=source.length;i++){signal?.throwIfAborted();if(!snippet.every((line,j)=>source[i+j]===line))continue;if(match!==undefined)return result('rejected','ambiguous-exact-text');match=i;}
 if(match===undefined)return result('rejected','no-exact-text');
 const start=match+1,end=match+snippet.length;
 if(!edits.some(e=>e[a.side].count>0&&start<e[a.side].start+e[a.side].count&&end>=e[a.side].start))return result('rejected','does-not-overlap-referenced-edit');
 const candidate=structuredClone(raw);candidate.anchor={...a,start,end};return {...result('corrected','unique-exact-text-overlaps-edit'),candidate};
}
