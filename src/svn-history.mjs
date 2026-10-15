import {realpath} from 'node:fs/promises';
import {checked} from './process.mjs';
import {xml} from './svn.mjs';
import {hash,decode,relativePath} from './content.mjs';
import {isSecretPath,assertNonSecretPath} from './secret-path.mjs';
import {captureProjectRules} from './project-rules.mjs';
import {snapshotMergeSources} from './svn-mergeinfo.mjs';
import {svnEolMapping} from './svn-eol-mapping.mjs';
import {fixedSvnLookup} from './svn-history-lookup.mjs';
import {svnHistoryDependencies} from './svn-history-dependencies.mjs';
import {svnHistoryCallers} from './svn-history-callers.mjs';
import {validateCallerScopes} from './caller-index.mjs';

const revision = value => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('SVN revision must be a fixed nonnegative decimal string');
  return value;
};
export function svnHistoryRange(options) {
  if (['commit','baseRevision','targetRevision'].some(key=>options[key]!==undefined)) throw new Error('SVN and Git revision parameters cannot be mixed');
  if (options.svnRevision!==undefined) {
    if (options.svnBaseRevision!==undefined || options.svnTargetRevision!==undefined) throw new Error('SVN revision and range are mutually exclusive');
    const target=revision(options.svnRevision);
    if (target==='0') throw new Error('SVN revision zero has no previous revision');
    return {base:String(Number(target)-1),target,mode:'svn-revision'};
  }
  const base=revision(options.svnBaseRevision),target=revision(options.svnTargetRevision);
  if (Number(base)>=Number(target)) throw new Error('SVN range requires base before target');
  return {base,target,mode:'svn-range'};
}

export function svnHistoryDestination(value, allowNetwork) {
  const scope=new URL(value);
  if(scope.username||scope.password||scope.search||scope.hash||!['file:','https:','http:','svn:','svn+ssh:'].includes(scope.protocol))throw new Error('Unsafe SVN repository URL');
  const networkAccess=scope.protocol!=='file:' || !!scope.hostname;
  if(networkAccess && allowNetwork!==true)throw new Error('SVN remote history requires explicit svnAllowNetwork: true before repository access');
  return {url:scope.href.replace(/\/$/,''),networkAccess};
}

export function mergeSvnHistoryRecord(previous, item) {
  if(!['added','deleted','modified','none'].includes(item?.['@_item'])||!['file','dir'].includes(item?.['@_kind']))throw new Error('Ambiguous or unsupported SVN history summary');
  if(!previous)return item;
  if(!['added','deleted'].includes(previous['@_item'])||!['added','deleted'].includes(item['@_item'])||previous['@_item']===item['@_item'])throw new Error('Ambiguous or unsupported SVN history summary');
  const old=previous['@_item']==='deleted'?previous:item,target=previous['@_item']==='added'?previous:item;
  return {...target,'@_item':'replaced',oldKind:old['@_kind'],newKind:target['@_kind']};
}

// Fixed URL objects only. No checkout, update, merge, working body or lazy HEAD read.
export async function captureSvnHistory(cwd,options={}) {
  const range=svnHistoryRange(options);
  if (options.svnAllowNetwork!==undefined && typeof options.svnAllowNetwork!=='boolean') throw new Error('Invalid SVN network opt-in');
  if (options.callerScopePaths!==undefined) validateCallerScopes(options.callerScopePaths);
  const contextPaths=options.contextPaths??[],oldContextPaths=options.oldContextPaths??[],rulePaths=options.rulePaths??[],maxContextFiles=options.maxContextFiles??20;
  if(!Number.isSafeInteger(maxContextFiles)||maxContextFiles<1||maxContextFiles>20||!Array.isArray(contextPaths)||contextPaths.length>maxContextFiles||new Set(contextPaths).size!==contextPaths.length||!Array.isArray(rulePaths)||rulePaths.length>4||new Set(rulePaths).size!==rulePaths.length||rulePaths.some(name=>contextPaths.includes(name)))throw new Error('Invalid SVN historical context or rule selection');
  if(!Array.isArray(oldContextPaths)||oldContextPaths.length>20||new Set(oldContextPaths).size!==oldContextPaths.length||contextPaths.length+oldContextPaths.length>maxContextFiles||oldContextPaths.some(name=>contextPaths.includes(name)||rulePaths.includes(name)))throw new Error('Invalid SVN old context selection');
  for(const name of [...contextPaths,...oldContextPaths,...rulePaths]){relativePath(name);assertNonSecretPath(name);}
  const {maxFiles=200,maxFileBytes=256*1024,maxSnapshotBytes=4*1024*1024,selectedPaths}=options;
  for(const [value,cap]of [[maxFiles,200],[maxFileBytes,256*1024],[maxSnapshotBytes,4*1024*1024]])if(!Number.isSafeInteger(value)||value<1||value>cap)throw new Error('Invalid SVN history limit');
  if(selectedPaths!==undefined && (!Array.isArray(selectedPaths)||selectedPaths.length>200||new Set(selectedPaths).size!==selectedPaths.length))throw new Error('Invalid SVN history selection');
  for(const name of selectedPaths??[])if(name!=='.')relativePath(name);
  const signal=AbortSignal.any([AbortSignal.timeout(30000),...(options.signal?[options.signal]:[])]);
  let commands=0,metadataBytes=0,sourceBytes=0;
  const budgetError = message => Object.assign(new Error(message), {code:'SVN_HISTORY_BUDGET'});
  const run=async(args,body=false)=>{
    signal.throwIfAborted();if(++commands>512 || metadataBytes>1024*1024 || sourceBytes>maxSnapshotBytes)throw budgetError('SVN historical shared budget exceeded');
    const bytes=await checked('svn',['--non-interactive',...args],{cwd,signal,maxBytes:body?maxFileBytes:1024*1024});
    if(body){sourceBytes+=bytes.length;if(sourceBytes>maxSnapshotBytes)throw budgetError('SVN historical source budget exceeded');}
    else{metadataBytes+=bytes.length;if(metadataBytes>1024*1024)throw budgetError('SVN historical metadata budget exceeded');}
    return bytes;
  };
  const local=xml(await run(['info','--xml','--','.@'])).info?.entry?.[0];
  if(!local?.['wc-info']?.['wcroot-abspath'] || !local.repository?.uuid || !local.url)throw new Error('Missing SVN working-copy identity');
  const root=await realpath(local['wc-info']['wcroot-abspath']);
  if(root!==await realpath(cwd))throw new Error('SVN historical scope must be working-copy root');
  const {url,networkAccess}=svnHistoryDestination(local.url,options.svnAllowNetwork);
  const at=(name,rev)=>(name==='.'?url:url+'/'+name.split('/').map(encodeURIComponent).join('/'))+'@'+rev;
  const identity=async(name,rev)=>{
    const node=xml(await run(['info','--xml','-r',rev,'--',at(name,rev)])).info?.entry?.[0];
    const expected=at(name,rev).slice(0,-rev.length-1);
    if(!node||node.url!==expected||String(node['@_revision'])!==rev||node.repository?.uuid!==local.repository.uuid||node.repository?.root!==local.repository.root||!['file','dir'].includes(node['@_kind']))throw new Error('SVN fixed historical identity mismatch');
    return node;
  };
  await identity('.',range.base);await identity('.',range.target);
  const summary=await run(['diff','--summarize','--xml','--notice-ancestry','-r',range.base+':'+range.target,'--',at('.',range.target)]);
  const raw=xml(summary).diff?.paths?.path;
  const paths=raw===undefined?[]:Array.isArray(raw)?raw:[raw];
  if(paths.length>maxFiles)throw new Error('SVN historical change count limit exceeded');
  const records=new Map();
  for(const item of paths){
    const value=item['#text'];
    if(typeof value!=='string'||(value!==url&&!value.startsWith(url+'/')))throw new Error('SVN historical path escaped scope');
    const name=value===url?'.':value.slice(url.length+1).split('/').map(part=>{
      const decoded=decodeURIComponent(part);if(decoded.includes('/')||decoded.includes('\\'))throw new Error('Encoded SVN path separator');return decoded;
    }).join('/');
    if(name!=='.')relativePath(name);
    records.set(name,mergeSvnHistoryRecord(records.get(name),item));
  }
  if(selectedPaths?.some(name=>!records.has(name)))throw new Error('Selected path is not an SVN historical change');
  const properties=async(name,rev)=>{
    const targets=xml(await run(['proplist','--xml','--verbose','-r',rev,'--',at(name,rev)])).properties?.target??[];
    const result=Object.create(null);
    for(const prop of targets.flatMap(t=>t.property??[])){
      if(typeof prop['@_name']!=='string'||prop['@_encoding']||Object.hasOwn(result,prop['@_name']))throw new Error('Unsupported historical property representation');
      result[prop['@_name']]=prop['#text']??'';
    }
    return Object.fromEntries(Object.entries(result).sort(([a],[b])=>a.localeCompare(b)));
  };
  const readSource=async(name,rev)=>{
    const node=await identity(name,rev),props=await properties(name,rev);
    if(Object.hasOwn(props,'svn:special'))throw new Error('Historical SVN special node excluded');
    const content=node['@_kind']==='dir'?decode(Buffer.alloc(0)):decode(await run(['cat','--ignore-keywords','-r',rev,'--',at(name,rev)],true));
    return {content,props,kind:node['@_kind'],source:{repositoryUuid:local.repository.uuid,url:at(name,rev).slice(0,-rev.length-1),pegRevision:rev,operativeRevision:rev,kind:node['@_kind'],hash:content.hash,textHash:hash(content.text)}};
  };
  const files=[];
  for(const [name,record]of [...records].sort(([a],[b])=>a<b?-1:a>b?1:0)){
    signal.throwIfAborted();
    const status=record['@_item'],item={id:hash(name),path:name,kind:record['@_kind'],oldKind:status==='added'?null:record.oldKind??record['@_kind'],newKind:status==='deleted'?null:record.newKind??record['@_kind'],rawStatus:status,eligibility:'reviewable',properties:[],rightExists:status!=='deleted'};
    files.push(item);
    if(isSecretPath(name)){item.eligibility='excluded';item.reason='Credential path excluded';continue;}
    if(selectedPaths&&!selectedPaths.includes(name)){item.eligibility='excluded';item.reason='Not explicitly selected';continue;}
    try{
      const readSide=async(rev,exists,kind)=>{
        if(!exists)return {content:decode(Buffer.alloc(0)),props:{}};
        const result=await readSource(name,rev);
        if(result.kind!==kind)throw new Error('Historical node kind differs');
        return result;
      };
      const left=await readSide(range.base,status!=='added',item.oldKind),right=await readSide(range.target,status!=='deleted',item.newKind);
       if(status==='replaced')item.nodeNotice='Fixed historical replacement; each side has its own node kind. Directory content is not file text; descendant changes require separate coverage.';
      item.left=left.content;item.right=right.content;
      item.svnSources={...(left.source?{old:left.source}:{}),...(right.source?{new:right.source}:{})};
      for(const key of [...new Set([...Object.keys(left.props),...Object.keys(right.props)])].sort())if(left.props[key]!==right.props[key])item.properties.push({name:key,old:left.props[key]??null,new:right.props[key]??null});
      item.propertyIdentity=hash(JSON.stringify([left.props,right.props]));
      item.textNotice='Fixed revision repository text; keywords unexpanded by svn cat --ignore-keywords. No working-copy text or keyword line remapping.';
      if(Object.hasOwn(left.props,'svn:eol-style')||Object.hasOwn(right.props,'svn:eol-style')){
        const mapping=side=>side.kind==='file'?svnEolMapping(side.content.text,side.props['svn:eol-style']??null):null;
        item.eolMapping={old:mapping(left),new:mapping(right)};
        item.textNotice+=' EOL metadata describes each existing file side only; null means absent or directory, not an empty file. Original fixed source bytes and LF evidence lines remain authoritative; lone CR has no normalized LF line identity.';
      }
    }catch(error){signal.throwIfAborted();if(error.code==='SVN_HISTORY_BUDGET')throw error;item.eligibility='blocked';item.reason=error.message;delete item.left;delete item.right;}
    if(Buffer.byteLength(JSON.stringify(files))>maxSnapshotBytes)throw new Error('SVN historical snapshot limit exceeded');
  }
  for(const item of files.filter(f=>(f.oldKind==='dir'||f.newKind==='dir')&&['added','deleted','replaced'].includes(f.rawStatus)&&f.eligibility==='reviewable').sort((a,b)=>b.path.length-a.path.length)){
    if(files.some(child=>child.path.startsWith(item.path==='.'?'':item.path+'/')&&child!==item&&child.eligibility!=='reviewable')){item.eligibility='blocked';item.reason='Historical directory descendant coverage incomplete';delete item.left;delete item.right;}
  }
  const mergeSources=snapshotMergeSources(files);
  const context=[];
  const targetContent=async(name)=>{
    const changed=files.find(file=>file.path===name);
    if(changed){
      if(changed.eligibility!=='reviewable'||changed.rightExists===false||changed.kind!=='file')throw new Error('Historical context or rule is excluded blocked deleted or not a file');
      return {content:changed.right,source:changed.svnSources.new};
    }
    const result=await readSource(name,range.target);if(result.kind!=='file')throw new Error('Historical context or rule requires a file');return result;
  };
  for(const name of [...contextPaths].sort()){
    const target=await targetContent(name),record=records.get(name),changed=files.find(file=>file.path===name);
    const item={path:name,...target.content,revision:range.target,svnSource:target.source};
    if(changed){if(changed.oldKind==='file'){item.oldText=changed.left.text;item.oldRevision=range.base;item.oldSvnSource=changed.svnSources.old;}}
    else{
      // No change record means both fixed sides are present and equal. Read and verify
      // rather than inferring baseline content from target or from the working tree.
      const old=await readSource(name,range.base);if(old.kind!=='file'||old.content.hash!==target.content.hash||JSON.stringify(old.props)!==JSON.stringify(target.props))throw new Error('Unchanged historical context identity mismatch');
      item.oldText=old.content.text;item.oldRevision=range.base;item.oldSvnSource=old.source;
    }
    context.push(item);
  }
  for(const name of [...oldContextPaths].sort()){
    const changed=files.find(file=>file.path===name);
    if(changed){
      if(changed.eligibility!=='reviewable'||changed.oldKind!=='file'||!changed.svnSources?.old)throw new Error('Old SVN context conflicts with excluded blocked or absent baseline change');
      // The original changed-file old identity already authorizes this side.
      continue;
    }
    const old=await readSource(name,range.base);if(old.kind!=='file')throw new Error('Old SVN context requires baseline file');
    context.push({path:name,oldOnly:true,oldText:old.content.text,oldHash:hash(old.content.text),oldRevision:range.base,oldSvnSource:old.source});
  }
  const rules=await captureProjectRules(root,rulePaths,{signal,files,read:async(_root,name)=>{
    const value=await targetContent(name);if(value.content.bytes>16*1024)throw new Error('Rule file size limit exceeded');return value.content;
  }});
  let autoContext,callerDiscovery;
  if(options.autoContext===true||options.callerScopePaths!==undefined){
    const probes=fixedSvnLookup({signal,list:async(name,rev)=>{
      const directory=await identity(name,rev);if(directory['@_kind']!=='dir')throw new Error('Historical lookup parent is not directory');
      const data=xml(await run(['list','--xml','--depth','immediates','-r',rev,'--',at(name,rev)]));
      const lists=data.lists?.list;
      const one=Array.isArray(lists)?lists:[lists];
      if(one.length!==1||!one[0]||one[0]['@_path']!==at(name,rev).slice(0,-rev.length-1))throw new Error('Historical directory listing identity mismatch');
      return (one[0].entry??[]).map(entry=>({name:entry.name,kind:entry['@_kind']}));
    }});
    const exactProbes=new Map();
    const lookup=async(name,rev)=>{
      const key=JSON.stringify([rev,name]);
      if(!exactProbes.has(key)){
        if(exactProbes.size>=512)throw new Error('SVN historical shared navigation probe limit exceeded');
        exactProbes.set(key,await probes.lookup(name,rev));
      }
      return exactProbes.get(key);
    };
    let navigationBytes=context.reduce((sum,item)=>sum+Buffer.byteLength(item.text??'')+Buffer.byteLength(item.oldText??''),0);
    const navigationRead=async(name,rev)=>{
      const value=await readSource(name,rev);navigationBytes+=value.content.bytes;
      if(navigationBytes>1024*1024)throw new Error('SVN historical shared navigation source limit exceeded');
      return value;
    };
    if(navigationBytes>1024*1024)throw new Error('SVN historical shared navigation source limit exceeded');
    if(options.callerScopePaths!==undefined){
      let indexRecords=0;
      const index=async(scopes,rev)=>{
        const entries=[];
        for(const scope of scopes){
          const node=await lookup(scope,rev);if(!node)continue;if(node.kind!=='dir')throw new Error('Historical caller scope is not directory');
          await identity(scope,rev);
          const data=xml(await run(['list','--xml','--depth','infinity','-r',rev,'--',at(scope,rev)]));
          const lists=data.lists?.list,one=Array.isArray(lists)?lists:[lists];
          if(one.length!==1||!one[0]||one[0]['@_path']!==at(scope,rev).slice(0,-rev.length-1))throw new Error('Historical caller listing identity mismatch');
          for(const entry of one[0].entry??[]){
            if(++indexRecords>256)throw new Error('Historical caller shared index limit exceeded');
            const name=relativePath(entry.name);entries.push({path:scope+'/'+name,kind:entry['@_kind']});
          }
        }
        return entries;
      };
      callerDiscovery=await svnHistoryCallers(files,range,options.callerScopePaths,context,{index,lookup,read:navigationRead,signal,maxContextFiles,rulePaths});
    }
    if(options.autoContext===true){
      autoContext=await svnHistoryDependencies(files,range,context,{lookup,read:navigationRead,signal,maxContextFiles,rulePaths});
      autoContext.directoryEntries=probes.usage().entries;
    }
    if(callerDiscovery)callerDiscovery.navigationSourceBytes=navigationBytes;
  }
  // Read the same fixed summary and repository identity again; never use HEAD.
  const after=await run(['diff','--summarize','--xml','--notice-ancestry','-r',range.base+':'+range.target,'--',at('.',range.target)]);
  if(!isDeepSummary(summary,after))throw new Error('SVN historical summary changed during capture');
  await identity('.',range.base);await identity('.',range.target);
  const snapshot={schemaVersion:1,vcs:'svn',root,repositoryUuid:local.repository.uuid,context,...(rules.length?{rules}:{}),...(autoContext?{autoContext}:{}),...(callerDiscovery?{callerDiscovery}:{}),history:{...range,vcs:'svn',url,repositoryUuid:local.repository.uuid,pegRevision:range.target,networkAccess,...(mergeSources.length?{mergeSources}:{}),semantics:'fixed revision tree endpoints; no merge attribution or working text'},files};
  const serialized=JSON.stringify(snapshot);if(Buffer.byteLength(serialized)>maxSnapshotBytes)throw new Error('SVN historical snapshot limit exceeded');
  return {...snapshot,id:hash(serialized)};
}
function isDeepSummary(a,b){
  const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
  return JSON.stringify(canonical(xml(a)))===JSON.stringify(canonical(xml(b)));
}
