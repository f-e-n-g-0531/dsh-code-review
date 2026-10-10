// Pure annotations over approved snapshot bodies. No capture, reads or coverage.
export function approvedCallerBindings(input, file) {
 const contexts=input.context??[],candidates=input.callerDiscovery?.candidates??[];
 return candidates.filter(candidate=>{
  if(candidate.targetPath!==file.path||!candidate.bindings?.length)return false;
  if(!input.history)return !candidate.side&&contexts.some(c=>c.path===candidate.fromPath&&typeof c.text==='string');
  const side=candidate.side,revision=side==='old'?input.history.base:side==='new'?input.history.target:undefined;
  if(!revision||candidate.revision!==revision)return false;
  if(side==='old'?(file.rawStatus==='A'||typeof file.left?.text!=='string'):(file.rightExists===false||typeof file.right?.text!=='string'))return false;
  return contexts.some(c=>c.path===candidate.fromPath&&(side==='old'?typeof c.oldText==='string'&&c.oldRevision===revision:typeof c.text==='string'&&c.revision===revision));
 }).map(({fromPath,bindings,side,revision})=>({fromPath,bindings,...(input.history?{side,revision,targetRevision:revision,contextSide:side==='old'?'context-old':'context'}:{})}));
}
