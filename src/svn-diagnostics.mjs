// Stable distinctions between review completion and unavailable coherent sources.
export const SVN_STATE_GUIDANCE=Object.freeze({
 SVN_MISSING_NODE:{recoverable:false,action:'Restore the intended file or explicitly schedule deletion outside this read-only review. Missing is not deletion.'},
 SVN_TEXT_CONFLICT:{recoverable:false,action:'Resolve the conflict outside review; conflict markers do not define an approved target.'},
 SVN_PROPERTY_CONFLICT:{recoverable:false,action:'Resolve property conflicts outside review before capturing target semantics.'},
 SVN_TREE_CONFLICT:{recoverable:false,action:'Resolve tree history outside review; do not infer replacement or copy provenance.'},
 SVN_OBSTRUCTED_NODE:{recoverable:false,action:'Choose the intended tracked node outside review; obstruction does not authorize arbitrary local data.'},
 SVN_INCOMPLETE_NODE:{recoverable:false,action:'Complete the working copy outside review; incomplete inventory is not a successful audit.'},
 SVN_SWITCHED_NODE:{recoverable:false,action:'Select an independently rooted working copy for the switched source or use explicit fixed branch endpoints.'},
 SVN_SWITCHED_ANCESTOR:{recoverable:false,action:'Use explicit fixed branch endpoints or an independently selected source root; do not reuse parent URL identity.'},
 SVN_EXTERNAL_NODE:{recoverable:false,action:'Review an external through its own explicit repository scope. Never follow externals implicitly.'},
 SVN_REPLACEMENT:{recoverable:true,action:'An explicit fixed repository baseline can define a separate comparison, not recover the removed local BASE.'},
 SVN_COPIED_REPLACEMENT:{recoverable:true,action:'Use explicit target-URL baseline; copy-source pristine is not target old data.'},
 SVN_SPARSE_STRUCTURE:{recoverable:false,action:'Select individual available nodes or a fixed repository tree; sparse descendants cannot imply deletion or complete coverage.'}
});
export function svnDiagnostic(code){return SVN_STATE_GUIDANCE[code]?{code,...SVN_STATE_GUIDANCE[code],readOnly:true,reviewCompleted:false}:null;}
