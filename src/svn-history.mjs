import {realpath} from 'node:fs/promises';
import {checked} from './process.mjs';
import {xml} from './svn.mjs';
import {hash,decode,relativePath} from './content.mjs';
import {isSecretPath} from './secret-path.mjs';

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

// Fixed URL objects only. No checkout, update, merge, working body or lazy HEAD read.
export async function captureSvnHistory(cwd,options={}) {
  const range=svnHistoryRange(options);
  if (options.svnAllowNetwork!==undefined && typeof options.svnAllowNetwork!=='boolean') throw new Error('Invalid SVN network opt-in');
  if (options.autoContext===true || options.callerScopePaths!==undefined || ['contextPaths','oldContextPaths','rulePaths'].some(key=>options[key]!==undefined && (!Array.isArray(options[key]) || options[key].length))) throw new Error('SVN historical context, rules and callers are not supported in this initial mode');
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
    if(records.has(name)||!['added','deleted','modified','none'].includes(item['@_item'])||!['file','dir'].includes(item['@_kind']))throw new Error('Ambiguous or unsupported SVN history summary');
    records.set(name,item);
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
  const files=[];
  for(const [name,record]of [...records].sort(([a],[b])=>a<b?-1:a>b?1:0)){
    signal.throwIfAborted();
    const status=record['@_item'],item={id:hash(name),path:name,kind:record['@_kind'],rawStatus:status,eligibility:'reviewable',properties:[],rightExists:status!=='deleted'};
    files.push(item);
    if(isSecretPath(name)){item.eligibility='excluded';item.reason='Credential path excluded';continue;}
    if(selectedPaths&&!selectedPaths.includes(name)){item.eligibility='excluded';item.reason='Not explicitly selected';continue;}
    try{
      const readSide=async(rev,exists)=>{
        if(!exists)return {content:decode(Buffer.alloc(0)),props:{}};
        const node=await identity(name,rev),props=await properties(name,rev);
        if(node['@_kind']!==item.kind)throw new Error('Historical node kind differs');
        if(Object.hasOwn(props,'svn:special'))throw new Error('Historical SVN special node excluded');
        const content=node['@_kind']==='dir'?decode(Buffer.alloc(0)):decode(await run(['cat','--ignore-keywords','-r',rev,'--',at(name,rev)],true));
        return {content,props,source:{repositoryUuid:local.repository.uuid,url:at(name,rev).slice(0,-rev.length-1),pegRevision:rev,operativeRevision:rev,hash:content.hash}};
      };
      const left=await readSide(range.base,status!=='added'),right=await readSide(range.target,status!=='deleted');
      item.left=left.content;item.right=right.content;
      item.svnSources={...(left.source?{old:left.source}:{}),...(right.source?{new:right.source}:{})};
      for(const key of [...new Set([...Object.keys(left.props),...Object.keys(right.props)])].sort())if(left.props[key]!==right.props[key])item.properties.push({name:key,old:left.props[key]??null,new:right.props[key]??null});
      item.propertyIdentity=hash(JSON.stringify([left.props,right.props]));
      item.textNotice='Fixed revision repository text; keywords unexpanded by svn cat --ignore-keywords. No working-copy text or keyword line remapping.';
    }catch(error){signal.throwIfAborted();if(error.code==='SVN_HISTORY_BUDGET')throw error;item.eligibility='blocked';item.reason=error.message;delete item.left;delete item.right;}
    if(Buffer.byteLength(JSON.stringify(files))>maxSnapshotBytes)throw new Error('SVN historical snapshot limit exceeded');
  }
  for(const item of files.filter(f=>f.kind==='dir'&&['added','deleted'].includes(f.rawStatus)&&f.eligibility==='reviewable')){
    if(files.some(child=>child.path.startsWith(item.path==='.'?'':item.path+'/')&&child!==item&&child.eligibility!=='reviewable')){item.eligibility='blocked';item.reason='Historical directory descendant coverage incomplete';delete item.left;delete item.right;}
  }
  // Read the same fixed summary and repository identity again; never use HEAD.
  const after=await run(['diff','--summarize','--xml','--notice-ancestry','-r',range.base+':'+range.target,'--',at('.',range.target)]);
  if(!isDeepSummary(summary,after))throw new Error('SVN historical summary changed during capture');
  await identity('.',range.base);await identity('.',range.target);
  const snapshot={schemaVersion:1,vcs:'svn',root,repositoryUuid:local.repository.uuid,context:[],history:{...range,vcs:'svn',url,repositoryUuid:local.repository.uuid,pegRevision:range.target,networkAccess,semantics:'fixed revision tree endpoints; no merge attribution or working text'},files};
  const serialized=JSON.stringify(snapshot);if(Buffer.byteLength(serialized)>maxSnapshotBytes)throw new Error('SVN historical snapshot limit exceeded');
  return {...snapshot,id:hash(serialized)};
}
function isDeepSummary(a,b){
  const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
  return JSON.stringify(canonical(xml(a)))===JSON.stringify(canonical(xml(b)));
}
