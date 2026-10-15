import {checked} from './process.mjs';
import {xml} from './svn.mjs';
import {readReplacementSource} from './svn-replacement-source.mjs';
import {svnWorkingIdentity} from './svn-working-identity.mjs';
import {hash,decode,relativePath,readLocal} from './content.mjs';
import {isSecretPath} from './secret-path.mjs';
import {svnKeywordMapping} from './svn-keyword-mapping.mjs';
import {svnEolMapping} from './svn-eol-mapping.mjs';
import {svnSpecialData} from './svn-special.mjs';
import {readWorkingSvnSpecial} from './svn-working-special.mjs';

// Fixed repository tree versus explicitly selected working replacement tree.
// Every descendant is a separate source/coverage unit, never an implicit approval.
export async function captureReplacementTree(root,rootInfo,name,options={}){
 relativePath(name);if(isSecretPath(name))throw new Error('Credential replacement root excluded');const revision=options.svnReplacementBaseRevision;
 const run=async args=>checked('svn',['--non-interactive',...args],{...options,cwd:root,maxBytes:1024*1024});
 const inventory=async()=>{const data=xml(await run(['status','--xml','--verbose','--ignore-externals','--depth','infinity','--',name+'@']));const map=new Map();for(const entry of data.status?.target?.flatMap(t=>t.entry??[])??[]){const p=entry['@_path'].replaceAll('\\','/');relativePath(p);if(p!==name&&!p.startsWith(name+'/')||map.has(p))throw new Error('Replacement working inventory escaped scope or duplicated');map.set(p,entry);if(map.size>200)throw new Error('Replacement working descendant count limit exceeded');}if(!map.has(name))throw new Error('Replacement root missing from working inventory');return map;};
 const current=await inventory(),oldRoot=await readReplacementSource(root,rootInfo,name,revision,options);
 const oldNodes=new Map([[name,oldRoot.kind],...oldRoot.descendants.map(x=>[x.path,x.kind])]);const paths=[...new Set([...oldNodes.keys(),...current.keys()])].sort();if(paths.length>200)throw new Error('Replacement combined descendant count limit exceeded');
 if(options.selectedPaths?.some(p=>(p===name||p.startsWith(name+'/'))&&!paths.includes(p)))throw new Error('Selected replacement descendant absent from both approved inventories');
 const files=[],receipts=[];
 const props=async p=>{const data=xml(await run(['proplist','--xml','--verbose','--',p+'@']));const out=Object.create(null);for(const x of data.properties?.target?.[0]?.property??[]){if(typeof x['@_name']!=='string'||x['@_encoding']||Object.hasOwn(out,x['@_name']))throw new Error('Unsafe replacement working properties');out[x['@_name']]=x['#text']??'';}return out;};
 const readCurrent=async p=>{const entry=current.get(p),s=entry?.['wc-status'];if(!entry)return null;if(!s)throw new Error('Replacement status missing node state');if(s['@_item']==='deleted')return null;
  if(['@_switched','@_file-external','@_tree-conflicted'].some(k=>s[k]==='true')||!['normal','modified','added','replaced'].includes(s['@_item'])||s['@_props']==='conflicted')throw new Error('Unsafe replacement descendant state');
  const node=xml(await run(['info','--xml','--',p+'@'])).info?.entry?.[0],identity=svnWorkingIdentity(node,rootInfo,p);if(!['file','dir'].includes(node['@_kind']))throw new Error('Unsupported replacement descendant kind');
  if(node['@_kind']==='dir'&&identity.source.depth!=='infinity')throw new Error('Sparse replacement target cannot prove descendant inventory');
  const properties=await props(p);if(Object.hasOwn(properties,'svn:externals'))throw new Error('Replacement externals require independent scope');
  const content=node['@_kind']==='dir'?decode(Buffer.alloc(0)):Object.hasOwn(properties,'svn:special')?(await readWorkingSvnSpecial(root,p,properties,options)).content:await readLocal(root,p,options);
  return {kind:node['@_kind'],content,props:properties,source:identity.source,identity:identity.fingerprint,special:svnSpecialData(content,properties,node['@_kind'])};
 };
 for(const p of paths){const f={id:hash(p),path:p,rawStatus:p===name?'replaced':'replacement-descendant',eligibility:'reviewable',properties:[],replacementTreeRoot:name,contentNotice:'Explicit fixed repository baseline versus current replacement tree. Not recovered local BASE or copy-source history. Every descendant requires independent approval; link records are data only.'};files.push(f);
  if(isSecretPath(p)){f.eligibility='excluded';f.reason='Credential replacement path excluded';continue;}if(options.selectedPaths&&!options.selectedPaths.includes(p)){f.eligibility='excluded';f.reason='Replacement descendant not explicitly selected';continue;}
  try{const old=oldNodes.has(p)?await readReplacementSource(root,rootInfo,p,revision,options):null,newer=await readCurrent(p);if(!old&&!newer)throw new Error('Replacement inventory node has no captured side');
   f.oldKind=old?.kind??null;f.newKind=newer?.kind??null;f.kind=newer?.kind??old.kind;f.rightExists=!!newer;f.left=old?.content??decode(Buffer.alloc(0));f.right=newer?.content??decode(Buffer.alloc(0));f.baseRevision=old?revision:undefined;
   if(old)f.replacementSource=old.source;if(newer)f.workingSource=newer.source;
   const a=old?.props??{},b=newer?.props??{};for(const key of [...new Set([...Object.keys(a),...Object.keys(b)])].sort())if(a[key]!==b[key])f.properties.push({name:key,old:a[key]??null,new:b[key]??null});
   const oldSpecial=old?svnSpecialData(old.content,a,old.kind):null;if(oldSpecial||newer?.special)f.specialData={old:oldSpecial,new:newer?.special??null};
   if(Object.hasOwn(a,'svn:eol-style')||Object.hasOwn(b,'svn:eol-style'))f.eolMapping={old:old?.kind==='file'?svnEolMapping(f.left.text,a['svn:eol-style']??null):null,new:newer?.kind==='file'?svnEolMapping(f.right.text,b['svn:eol-style']??null):null};
   if(b['svn:keywords']&&newer?.kind==='file'){const {text,...mapping}=svnKeywordMapping(f.right.text,b['svn:keywords']);f.keywordMapping={new:{...mapping,status:'working-line-view'},notice:'Old side is fixed repository text read with --ignore-keywords, not local BASE. Current contraction preserves lines only, not behavioral equivalence.'};}
   receipts.push({path:p,old:old?.source??null,current:newer?hash(JSON.stringify([newer.identity,newer.props,newer.content.hash])):null});
  }catch(error){options.signal?.throwIfAborted();if(error.code==='SVN_CAPTURE_BUDGET')throw error;f.eligibility='blocked';f.reason=error.message;delete f.left;delete f.right;}
 }
 for(const f of files.filter(f=>f.oldKind==='dir'||f.newKind==='dir').sort((a,b)=>b.path.length-a.path.length)){const children=files.filter(x=>x.path.startsWith(f.path+'/'));f.structuralDescendants=children.map(x=>x.path);if(f.eligibility==='reviewable'&&children.some(x=>x.eligibility!=='reviewable')){f.eligibility='blocked';f.reason='Replacement descendant coverage incomplete';delete f.left;delete f.right;}}
 const verify=async()=>{const again=await inventory();const canonical=m=>JSON.stringify([...m].map(([p,e])=>[p,Object.fromEntries(Object.entries(e['wc-status']??{}).sort())]).sort());if(canonical(again)!==canonical(current))throw new Error('Replacement working inventory changed');
  const oldAgain=await readReplacementSource(root,rootInfo,name,revision,options);if(JSON.stringify(oldAgain.source)!==JSON.stringify(oldRoot.source))throw new Error('Replacement old inventory changed');
  for(const receipt of receipts){if(receipt.old){const value=await readReplacementSource(root,rootInfo,receipt.path,revision,options);if(JSON.stringify(value.source)!==JSON.stringify(receipt.old))throw new Error('Replacement old descendant changed');}const value=await readCurrent(receipt.path);const fingerprint=value?hash(JSON.stringify([value.identity,value.props,value.content.hash])):null;if(fingerprint!==receipt.current)throw new Error('Replacement working descendant changed');}
 };
 return {files,verify};
}
