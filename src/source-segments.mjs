// Linear segmentation of approved text. Coordinates remain original one-based lines.
export function sourceSegments(windows,{maxBytes=12000,maxLines=100}={}){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||!Number.isSafeInteger(maxLines)||maxLines<1)throw new Error('Invalid source segment limits');
 const out=[];for(const w of windows){if(w.old.count<=maxLines&&w.new.count<=maxLines&&Buffer.byteLength(w.old.text)<=maxBytes&&Buffer.byteLength(w.new.text)<=maxBytes){out.push(w);continue;}const sides={old:w.old.text.match(/[^\n]*\n|[^\n]+$/g)??[],new:w.new.text.match(/[^\n]*\n|[^\n]+$/g)??[]},pos={old:0,new:0};let i=0;
  while(pos.old<sides.old.length||pos.new<sides.new.length){const item={id:w.id+'-s'+(++i),editIds:[...w.editIds]};for(const side of ['old','new']){const start=pos[side],parts=[];let bytes=0;while(pos[side]<sides[side].length&&parts.length<maxLines){const line=sides[side][pos[side]],n=Buffer.byteLength(line);if(parts.length&&bytes+n>maxBytes)break;parts.push(line);bytes+=n;pos[side]++;if(bytes>=maxBytes)break;}item[side]={start:w[side].start+start,count:parts.length,text:parts.join('')};}out.push(item);}
  if(!i)out.push(w);
 }return out;
}
