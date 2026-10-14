// Stable offline diagnoses, not permission to resolve or mutate working nodes.
export function svnStateIssue(state) {
  if (!state || typeof state['@_item'] !== 'string') return {code:'SVN_INVALID_STATE',reason:'SVN status entry is incomplete'};
  const item=state['@_item'];
  if (state['@_tree-conflicted']==='true') return {code:'SVN_TREE_CONFLICT',reason:'Tree conflict requires explicit user resolution; no coherent target inferred'};
  if (item==='conflicted') return {code:'SVN_TEXT_CONFLICT',reason:'Text conflict is unresolved; conflict markers are not a resolved target'};
  if (state['@_props']==='conflicted') return {code:'SVN_PROPERTY_CONFLICT',reason:'Property conflict is unresolved; property values are not a resolved target'};
  if (item==='missing') return {code:'SVN_MISSING_NODE',reason:'Tracked node is missing without scheduled deletion; no deletion inferred'};
  if (item==='obstructed') return {code:'SVN_OBSTRUCTED_NODE',reason:'Working node obstructs the tracked node; no replacement inferred'};
  if (item==='incomplete') return {code:'SVN_INCOMPLETE_NODE',reason:'Working-copy node is incomplete; source coverage is unavailable'};
  if (item==='replaced') return {code:state['@_copied']==='true'?'SVN_COPIED_REPLACEMENT':'SVN_REPLACEMENT',reason:'Replacement requires verified target old node; local BASE may be unavailable or describe the copy source'};
  if (state['@_switched']==='true') return {code:'SVN_SWITCHED_NODE',reason:'Switched node requires separately frozen repository URL identity'};
  if (state['@_file-external']==='true' || item==='external') return {code:'SVN_EXTERNAL_NODE',reason:'External node requires a separate explicitly selected repository scope'};
  if (state['@_copied']==='true' && item!=='added') return {code:'SVN_COPIED_NODE',reason:'Copied non-addition requires verified target baseline'};
  if (!['modified','added','deleted','normal','unversioned'].includes(item)) return {code:'SVN_UNSUPPORTED_STATE',reason:'Unsupported SVN node state: '+item};
  return null;
}
