import {captureSignal} from './capture-signal.mjs';
import {checked} from './process.mjs';
import {xml} from './svn.mjs';
import {hash} from './content.mjs';
import {svnWorkingIdentity} from './svn-working-identity.mjs';
import {captureEffectiveMergeinfo} from './svn-effective-mergeinfo.mjs';

export async function workingEffectiveMergeinfo(root,rootInfo,files,options={}){
 const signal=captureSignal(options.signal);let commands=0,bytes=0;const cache=new Map();
 const run=async args=>{signal.throwIfAborted();commands++;const data=await checked('svn',['--non-interactive',...args],{...options,cwd:root,signal,maxBytes:256*1024});bytes+=data.length;if(bytes>1024*1024)throw new Error('SVN working mergeinfo metadata budget exceeded');return xml(data);};
 const read=async(name,side,revision)=>{
  const key=JSON.stringify([name,side]);if(cache.has(key)){const value=cache.get(key);if(side==='old'&&value.source.revision!==revision)throw new Error('Mixed BASE revisions cannot prove effective mergeinfo');return value;}
  const node=(await run(['info','--xml','--',name+'@'])).info?.entry?.[0];const identity=svnWorkingIdentity(node,rootInfo,name);
  const entries=(await run(['status','--xml','--verbose','--ignore-externals','--depth','empty','--',name+'@'])).status?.target?.flatMap(t=>t.entry??[])??[];const state=entries[0]?.['wc-status'];
  if(entries.length!==1||!state||['@_switched','@_file-external','@_tree-conflicted','@_copied'].some(k=>state[k]==='true')||!['normal','modified','deleted'].includes(state['@_item'])||state['@_props']==='conflicted')throw new Error('Unsafe ancestor state for effective mergeinfo');
  if(side==='old'&&String(node['@_revision'])!==revision)throw new Error('Mixed BASE revisions cannot prove effective mergeinfo');
  const props=(await run(['proplist','--xml','--verbose',...(side==='old'?['-r','BASE']:[]),'--',name+'@'])).properties?.target?.[0]?.property??[];const values=Object.create(null);
  for(const p of props){if(typeof p['@_name']!=='string'||p['@_encoding']||Object.hasOwn(values,p['@_name']))throw new Error('Unsafe effective mergeinfo property representation');values[p['@_name']]=p['#text']??'';}
  if(Object.hasOwn(values,'svn:externals')||Object.hasOwn(values,'svn:special'))throw new Error('Unsafe ancestor properties for effective mergeinfo');
  const source={...identity.source,side,revision:String(node['@_revision']),propertyHash:hash(JSON.stringify(Object.entries(values).sort()))};
  const record={path:name,present:Object.hasOwn(values,'svn:mergeinfo'),...(Object.hasOwn(values,'svn:mergeinfo')?{value:values['svn:mergeinfo']}:{}),identity:hash(JSON.stringify(source)),source};cache.set(key,record);return record;
 };
 const results=[];
 for(const file of files.filter(f=>f.eligibility==='reviewable')){const value={path:file.path};for(const side of ['old','new']){
   if(side==='old'&&['added','unversioned'].includes(file.rawStatus)||side==='new'&&file.rawStatus==='deleted'){value[side]={status:'absent',sources:[]};continue;}
   if(file.replacementTreeRoot||file.replacementSource||file.copySource||file.targetAddition||file.rawStatus==='unversioned'){value[side]={status:'unknown',reason:'Added/copied/untracked ancestor semantics require separate provenance',sources:[]};continue;}
   try{value[side]=await captureEffectiveMergeinfo(file.path,{signal,boundary:'.',complete:rootInfo.url===rootInfo.repository.root,read:name=>read(name,side,String(file.baseRevision))});for(const evidence of value[side].evidence??[])evidence.source=cache.get(JSON.stringify([evidence.path,side])).source;}catch(error){signal.throwIfAborted();if(error.code==='SVN_CAPTURE_BUDGET'||/budget exceeded/.test(error.message))throw error;value[side]={status:'unknown',reason:error.message,sources:[]};}
  }results.push(value);}
 // Re-read every captured property/identity after collection, charging same budget.
 const original=[...cache.entries()];cache.clear();for(const [key,record]of original){const [name,side]=JSON.parse(key);if((await read(name,side,record.source.revision)).identity!==record.identity)throw new Error('Effective working mergeinfo changed during capture');}
 return results;
}
