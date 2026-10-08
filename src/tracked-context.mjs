import { checked } from './process.mjs';
import { relativePath } from './content.mjs';
// Index metadata only; never invokes network, diff drivers or source reads.
export async function gitContextIndex(root, options = {}) {
 const bytes = await checked('git', ['--no-optional-locks','-c','core.fsmonitor=false','-c','core.untrackedCache=false','ls-files','--stage','-z'], {...options,cwd:root,maxBytes:1024*1024});
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
