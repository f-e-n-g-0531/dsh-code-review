import { isSecretPath, assertNonSecretPath } from './secret-path.mjs';
import {captureProjectRules} from './project-rules.mjs';
import {contextCandidates} from './context-candidates.mjs';
import {realpath} from 'node:fs/promises';
import {checked} from './process.mjs';
import {hash,decode,relativePath} from './content.mjs';
const utf8=b=>new TextDecoder('utf-8',{fatal:true}).decode(b);
// Object-only capture: no checkout, worktree reads, external diff or fetch.
export async function captureGitHistory(cwd, options={}) {
 const {commit,baseRevision,targetRevision,selectedPaths,signal,maxFiles=200,maxFileBytes=256*1024,maxSnapshotBytes=4*1024*1024}=options;
 if(!Number.isSafeInteger(maxFiles)||maxFiles<1||maxFiles>200||!Number.isSafeInteger(maxFileBytes)||maxFileBytes<1||maxFileBytes>256*1024||!Number.isSafeInteger(maxSnapshotBytes)||maxSnapshotBytes<1||maxSnapshotBytes>4*1024*1024)throw new Error('Invalid historical capture limits');
 if(selectedPaths!==undefined&&(!Array.isArray(selectedPaths)||selectedPaths.some(p=>relativePath(p)!==p)))throw new Error('Invalid selected paths');
 const git=(root,args,limit=1024*1024)=>checked('git',['--no-optional-locks','-c','core.fsmonitor=false','-c','core.untrackedCache=false',...args],{...options,cwd:root,maxBytes:limit});
 const root=await realpath(utf8(await git(cwd,['rev-parse','--show-toplevel'])).trim());
 const resolve=async ref=>{if(typeof ref!=='string'||!ref||ref.length>256||ref.startsWith('-')||/[\s\0]/.test(ref))throw new Error('Invalid revision');const oid=utf8(await git(root,['rev-parse','--verify','--end-of-options',ref+'^{commit}'])).trim();if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid))throw new Error('Invalid commit object');return oid;};
 let base,target;
 if(commit!==undefined){if(baseRevision!==undefined||targetRevision!==undefined)throw new Error('Commit and range are mutually exclusive');target=await resolve(commit);const object=utf8(await git(root,['cat-file','commit',target]));const header=object.split('\n\n',1)[0];const parents=header.split('\n').filter(line=>line.startsWith('parent ')).map(line=>line.slice(7));if(parents.some(oid=>!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)))throw new Error('Invalid commit parent');if(parents.length>1)throw new Error('Merge commit requires explicit revision range');base=parents[0]??null;}
 else {base=await resolve(baseRevision);target=await resolve(targetRevision);}
 // Metadata scales with changed paths, not every tracked file in either tree.
 const raw=utf8(await git(root,['diff-tree','--no-abbrev','--raw','-z','-r','--no-renames','--no-ext-diff','--no-textconv','--no-commit-id',...(base?[base,target]:['--root',target]),'--'])).split('\0');
 if(raw.at(-1)==='')raw.pop();
 const left=new Map(),right=new Map(),names=[];
 if(raw.length%2)throw new Error('Invalid historical diff metadata');
 for(let i=0;i<raw.length;i+=2){const m=/^:(\d{6}) (\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([a-f0-9]{40}|[a-f0-9]{64}) ([AMDT])$/.exec(raw[i]);if(!m)throw new Error('Invalid historical diff metadata');const name=relativePath(raw[i+1]);if(names.includes(name))throw new Error('Duplicate historical change');names.push(name);for(const [map,mode,oid] of [[left,m[1],m[3]],[right,m[2],m[4]]])if(mode!=='000000')map.set(name,{mode,type:mode==='160000'?'commit':'blob',oid});}
 names.sort();
 // Literal, nonrecursive lookups cannot enumerate a supplied directory or wildcard.
 const lookup=async (oid,map,requested)=>{if(!oid)return;const pending=[...new Set(requested)].filter(p=>!map.has(p));for(let i=0;i<pending.length;i++){const paths=pending.slice(i,i+1);paths.forEach(relativePath);const records=utf8(await git(root,['--literal-pathspecs','ls-tree','-z','--full-tree',oid,'--',...paths])).split('\0').filter(Boolean);for(const r of records){const m=/^(\d{6}) (blob|commit|tree) ([a-f0-9]+)\t([\s\S]+)$/.exec(r);if(!m||!paths.includes(m[4]))throw new Error('Invalid historical path lookup');map.set(m[4],{mode:m[1],type:m[2],oid:m[3]});}}};
 if(names.length>maxFiles)throw new Error('Historical change count limit exceeded');if(selectedPaths?.some(p=>!names.includes(p)))throw new Error('Selected path is not a historical change');
 const files=[];for(const name of names){signal?.throwIfAborted();const l=left.get(name),r=right.get(name),item={id:hash(name),path:name,rawStatus:!l?'A':!r?'D':'M',eligibility:'reviewable',properties:[]};files.push(item);if(isSecretPath(name)){item.eligibility='excluded';item.reason='Credential path excluded';continue;}if(selectedPaths&&!selectedPaths.includes(name)){item.eligibility='excluded';item.reason='Not explicitly selected';continue;}try{for(const e of [l,r].filter(Boolean))if(e.type!=='blob'||!['100644','100755'].includes(e.mode))throw new Error('Historical link or submodule excluded');const read=async e=>decode(e?await git(root,['cat-file','blob',e.oid],maxFileBytes):Buffer.alloc(0));item.left=await read(l);item.right=await read(r);item.rightExists=!!r;if(l&&r&&item.left.hash===item.right.hash){item.eligibility='excluded';item.reason='Mode-only historical change not analyzed';}}catch(error){signal?.throwIfAborted();item.eligibility='blocked';item.reason=error.message;delete item.left;delete item.right;}if(Buffer.byteLength(JSON.stringify(files))>maxSnapshotBytes)throw new Error('Historical snapshot limit exceeded');}
 const rulePaths=options.rulePaths ?? [];
 const contextPaths=options.contextPaths ?? [], oldContextPaths=options.oldContextPaths ?? [], maxContextFiles=options.maxContextFiles ?? 20;
 if(!Array.isArray(oldContextPaths)||oldContextPaths.length>20||new Set(oldContextPaths).size!==oldContextPaths.length)throw new Error('Invalid old context paths');
 for(const name of oldContextPaths){relativePath(name);assertNonSecretPath(name);}
 if(oldContextPaths.length&&!base)throw new Error('Old context requires nonempty historical baseline');
 if(!Array.isArray(contextPaths)||!Array.isArray(rulePaths))throw new Error('Invalid historical context or rule paths');
 if(oldContextPaths.some(p=>contextPaths.includes(p)||rulePaths.includes(p)))throw new Error('Old context paths must be separate');
 if(contextPaths.length+oldContextPaths.length>maxContextFiles)throw new Error('Historical context file limit exceeded');
 if(!Array.isArray(contextPaths)||!Number.isSafeInteger(maxContextFiles)||maxContextFiles<1||maxContextFiles>20||contextPaths.length>maxContextFiles)throw new Error('Historical context file limit exceeded');
 if(options.autoContext!==undefined&&typeof options.autoContext!=='boolean')throw new Error('Invalid autoContext option');
 if(!Array.isArray(rulePaths)||rulePaths.length>4||rulePaths.some(p=>contextPaths.includes(p)))throw new Error('Rule paths must be separate from context paths');
 await lookup(target,right,[...contextPaths,...rulePaths]);await lookup(base,left,[...contextPaths,...oldContextPaths]);
 const context=[], regular=e=>e?.type==='blob'&&['100644','100755'].includes(e.mode);
 const captureContext=async name=>{relativePath(name);assertNonSecretPath(name);const changed=files.find(f=>f.path===name);if(changed){if(changed.eligibility!=='reviewable'||changed.rightExists===false)throw new Error('Historical context is excluded blocked or deleted');return {path:name,...changed.right};}const entry=right.get(name);if(!regular(entry))throw new Error('Historical context not a target regular blob');const content=decode(await git(root,['cat-file','blob',entry.oid],maxFileBytes));const previous=left.get(name);return {path:name,...content,revision:target,...(regular(previous)?{oldText:decode(await git(root,['cat-file','blob',previous.oid],maxFileBytes)).text,oldRevision:base}:{})};};
 for(const name of [...new Set(contextPaths)].sort())context.push(await captureContext(name));
 for(const name of [...oldContextPaths].sort()){
  const changed=files.find(f=>f.path===name);
  if(changed){if(changed.eligibility!=='reviewable'||!left.has(name))throw new Error('Old context conflicts with excluded blocked or absent old change');continue;}
  const entry=left.get(name);if(!regular(entry))throw new Error('Old context not a baseline regular blob');
  const content=decode(await git(root,['cat-file','blob',entry.oid],maxFileBytes));
  context.push({path:name,oldOnly:true,oldText:content.text,oldHash:hash(content.text),oldBlobOid:entry.oid,oldRevision:base});
 }
 const rules=await captureProjectRules(root,rulePaths,{signal,files,read:async (_root,name,{maxFileBytes:limit})=>{const entry=right.get(name);if(!regular(entry))throw new Error('Historical rule not a target regular blob');return decode(await git(root,['cat-file','blob',entry.oid],limit));}});
 let autoContext;
 if(options.autoContext===true){const probes=new Set();const oldFiles=files.map(f=>f.eligibility==='reviewable'?{...f,right:f.left,rightExists:true}:f);const onProbe=paths=>{for(const p of paths)probes.add(p);if(probes.size>512)throw new Error('Historical context lookup limit exceeded');};contextCandidates(files,[],{onProbe});contextCandidates(oldFiles,[],{onProbe});await lookup(target,right,[...probes]);await lookup(base,left,[...probes]);const plan=contextCandidates(files,[...right.keys()]);const oldPlan=contextCandidates(files.map(f=>f.eligibility==='reviewable'?{...f,right:f.left,rightExists:true}:f),[...left.keys()]);const combined=new Map(plan.candidates.map(c=>[c.path,{...c,sourceSides:['new']}]));for(const c of oldPlan.candidates){if(combined.has(c.path))combined.get(c.path).sourceSides.push('old');else combined.set(c.path,{...c,sourceSides:['old']});}plan.candidates=[...combined.values()].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);plan.truncated ||= oldPlan.truncated;autoContext={...plan,notice:'Direct baseline/target-tree import/include navigation only; no caller coverage, binding or working-tree reads.',target,base,candidates:plan.candidates.filter(c=>!contextPaths.includes(c.path)&&!oldContextPaths.includes(c.path)&&!rulePaths.includes(c.path)),capturedPaths:[]};for(const c of autoContext.candidates){signal?.throwIfAborted();if(context.length>=maxContextFiles){c.status='blocked';c.reason='Context file limit exceeded';continue;}try{context.push(await captureContext(c.path));c.status='captured';autoContext.capturedPaths.push(c.path);}catch(error){signal?.throwIfAborted();c.status='blocked';c.reason=error.message;}}}
 const snapshot={context,...(rules.length?{rules}:{}),...(autoContext?{autoContext}:{}),schemaVersion:1,vcs:'git',root,baseline:base,history:{mode:commit!==undefined?'commit':'range',base,target,semantics:'exact-tree-endpoints; renames represented as add/delete'},files};const serialized=JSON.stringify(snapshot);if(Buffer.byteLength(serialized)>maxSnapshotBytes)throw new Error('Historical snapshot limit exceeded');return {...snapshot,id:hash(serialized)};
}
