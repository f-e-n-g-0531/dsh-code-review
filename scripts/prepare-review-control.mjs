import {mkdir,writeFile,readFile,realpath,lstat,readdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const hash=x=>createHash('sha256').update(x).digest('hex');
export function safeSourcePath(value){if(typeof value!=='string'||!value||value.includes(String.fromCharCode(0))||value.includes(':')||value.startsWith('/')||value.startsWith('\\')||value.split(/[\\/]/).some(x=>x==='..'||x===''||x==='.'&&value!=='.'))throw Error('Unsafe source path');return value;}
export async function authorizeManifestOperation(root,manifest,name,args){
 const fs=await import('node:fs/promises'),p=await import('node:path');
 if(!['read','glob','grep'].includes(name))throw Error('Capability denied');
 const base=await fs.realpath(root);
 if(!Array.isArray(manifest.entries)||manifest.entries.some(x=>typeof x.file!=='string'||x.file.includes('%')||x.file.includes(':')||x.file.split(/[\\/]/).some(v=>v==='..'||!v)||p.isAbsolute(x.file)))throw Error('Invalid manifest paths');
 const allowed=new Set(manifest.entries.map(x=>p.resolve(base,x.file)));
 allowed.add(p.join(base,'manifest.json'));
 const raw=name==='read'?args?.file_path:args?.path;
 if(typeof raw!=='string'||!p.isAbsolute(raw)||raw.includes('%')||raw.includes(String.fromCharCode(0))||raw.slice(p.parse(raw).root.length).includes(':'))throw Error('Explicit absolute evidence target required');
 const target=p.resolve(base,raw??'.'),rel=p.relative(base,target);
 if(rel==='..'||rel.startsWith('..'+p.sep)||p.isAbsolute(rel))throw Error('Outside evidence root');
 let cur=base;for(const part of rel.split(p.sep).filter(Boolean)){cur=p.join(cur,part);if((await fs.lstat(cur)).isSymbolicLink())throw Error('Links denied');}
 if(await fs.realpath(target)!==target)throw Error('Noncanonical target');
 const verify=async file=>{const entry=manifest.entries.find(x=>p.resolve(base,x.file)===file);if(entry){const crypto=await import('node:crypto');if(crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex')!==entry.sha256)throw Error('Evidence content changed');}};
 if(name==='read'){if(!allowed.has(target)||(await fs.lstat(target)).isFile()!==true)throw Error('Unlisted source');await verify(target);return;}
 if(name==='glob'&&(typeof args.pattern!=='string'||args.pattern.includes('..')||args.pattern.includes('%')||p.isAbsolute(args.pattern)||args.pattern.includes(':')))throw Error('Unsafe glob');
 const walk=async file=>{const s=await fs.lstat(file);if(s.isSymbolicLink())throw Error('Links denied');if(s.isDirectory()){for(const n of await fs.readdir(file))await walk(p.join(file,n));}else{if(!s.isFile()||!allowed.has(file))throw Error('Unlisted source in search tree');await verify(file);}};
 await walk(target);
}
export function guardModule(){return [
 "import {readFile,realpath} from 'node:fs/promises';",
 "import {createHash} from 'node:crypto';",
 'const authorize='+authorizeManifestOperation.toString()+';',
 "export const name='neutral-manifest-filesystem-guard';",
 "export const inject=['tools'];",
 "export async function apply(ctx,config){",
 "const root=await realpath(config.root),bytes=await readFile(config.manifest);",
 "if(createHash('sha256').update(bytes).digest('hex')!==config.manifestSha256)throw Error('Manifest identity changed');",
 "const manifest=JSON.parse(bytes);ctx.tools.restrict({allow:['read','glob','grep']});",
 "ctx.on('tools/pre-execute',async(exec,next)=>{try{await authorize(root,manifest,exec.name,exec.arguments);}catch{return {kind:'deny',reason:'Outside approved evidence capabilities'};}return next();});",
 "}"
 ].join(String.fromCharCode(10));}
export function propertyChunks(value,maxBytes=1024){
 if(typeof value!=='string'||!Number.isSafeInteger(maxBytes)||maxBytes<4)throw Error('Invalid property chunk');
 const chunks=[];let text='',bytes=0;
 for(const ch of value){const n=Buffer.byteLength(ch);if(bytes+n>maxBytes){chunks.push(text);text='';bytes=0;}text+=ch;bytes+=n;}
 if(text||!chunks.length)chunks.push(text);return chunks;
}
export async function prepareReviewControl({snapshotFile,outputDir}){
 if(!path.isAbsolute(snapshotFile??'')||!path.isAbsolute(outputDir??''))throw Error('Absolute paths required');
 const raw=await readFile(snapshotFile),snapshot=JSON.parse(raw);
 if(!Array.isArray(snapshot.files)||snapshot.files.length>200)throw Error('Invalid snapshot');
 const records=[],entries=[],bodies=[];let bytes=0;
 const add=(kind,id,original,side,text)=>{if(typeof text!=='string')return;bytes+=Buffer.byteLength(text);if(bytes>64*1024*1024)throw Error('Export too large');const file=kind+'/'+hash(JSON.stringify([id,original,side]))+'.txt';entries.push({file,sourceId:id,path:original,side,sha256:hash(text),bytes:Buffer.byteLength(text)});bodies.push({file,text});};
 const propertyValue=(value,id,original,name,side)=>{
  if(value===undefined)return {valueType:'absent'};
  if(value===null)return {valueType:'null'};
  if(typeof value!=='string')throw Error('Unsupported property representation');
  const chunks=propertyChunks(value).map((text,index)=>{const sourceId=hash(JSON.stringify([id,name,side,index]));add('properties',sourceId,original,'property-'+side,text);const entry=entries.at(-1);entry.propertyName=name;entry.chunkIndex=index;return {file:entry.file,bytes:entry.bytes,sha256:entry.sha256};});
  return {valueType:'string',bytes:Buffer.byteLength(value),sha256:hash(value),chunks};
 };
 for(const [i,f] of snapshot.files.entries()){
  const original=safeSourcePath(f.path);const id=typeof f.id==='string'?f.id:'f'+i;
  records.push({id,path:original,status:f.status??f.rawStatus,kind:f.kind,oldKind:f.oldKind,newKind:f.newKind,oldHash:f.left?.hash,newHash:f.right?.hash,eligibility:f.eligibility??'blocked',reason:typeof f.reason==='string'?f.reason:undefined,properties:(f.properties??[]).map(p=>{if(typeof p.name!=='string'||!p.name)throw Error('Invalid property name');return {name:p.name,old:propertyValue(p.old,id,original,p.name,'old'),new:propertyValue(p.new,id,original,p.name,'new')};}),oldExists:f.left?.exists??f.leftExists,newExists:f.right?.exists??f.rightExists,oldEncoding:f.left?.encoding,newEncoding:f.right?.encoding,oldTextAvailable:typeof f.left?.text==='string',newTextAvailable:typeof f.right?.text==='string'});
  add('old',id,original,'old',f.left?.text);add('new',id,original,'new',f.right?.text);
 }
 for(const [i,c] of (snapshot.context??[]).entries()){const original=safeSourcePath(c.path);add('context','context-'+i,original,'context',c.text);add('context','context-old-'+i,original,'context-old',c.oldText);}
 const manifest={version:2,propertyFormat:{encoding:'utf8',chunkMaxBytes:1024,reassembly:'Concatenate chunk file bytes in listed order without inserting separators; validate value SHA256.'},snapshotId:snapshot.id,snapshotSha256:hash(raw),history:{base:snapshot.history?.base,target:snapshot.history?.target,repositoryUuid:snapshot.history?.repositoryUuid,url:snapshot.history?.url},records,entries};
 const text=JSON.stringify(manifest,null,2)+String.fromCharCode(10);
 await mkdir(outputDir);for(const dir of ['old','new','context','properties'])await mkdir(path.join(outputDir,dir));
 for(const b of bodies)await writeFile(path.join(outputDir,b.file),b.text,{flag:'wx'});
 await writeFile(path.join(outputDir,'manifest.json'),text,{flag:'wx'});
 // Keep guard outside searchable evidence root: it is policy, never model evidence.
 await writeFile(outputDir+'.guard.mjs',guardModule(),{flag:'wx'});
 return {outputDir,manifestSha256:hash(text),snapshotId:snapshot.id,entryCount:entries.length,recordCount:records.length,guardFile:outputDir+'.guard.mjs'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){try{if(process.argv.length!==4||process.argv[2]!=='--config')throw Error('Usage');console.log(JSON.stringify(await prepareReviewControl(JSON.parse(await readFile(process.argv[3],'utf8')))));}catch{console.error('Evidence preparation refused');process.exitCode=1;}}
