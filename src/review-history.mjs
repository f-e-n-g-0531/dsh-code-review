import { hash } from './content.mjs';
import { buildFindingLedger } from './finding-ledger.mjs';
import { buildIncrementalSelection, incrementalFileHash } from './incremental-review.mjs';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,canonical(value[k])])) : value;
const digest = value => hash(JSON.stringify(canonical(value)));
export function reviewHistoryIdentity(snapshot,route,capturePolicy={}) {
  return {repository:digest({root:snapshot.root,vcs:snapshot.vcs,repositoryUuid:snapshot.repositoryUuid ?? snapshot.history?.repositoryUuid,url:snapshot.repositoryUrl ?? snapshot.history?.url}),route:digest(route),rulesHash:digest(snapshot.rules??[]),requirementPolicyHash:digest({requirement:snapshot.businessRequirement,capturePolicy})};
}
export function reviewSourceManifest(snapshot,identity) {
  // No inferred complete dependency graph: conservatively bind every captured source.
  const files=snapshot.files.map(file=>({path:file.path,hash:incrementalFileHash(file)}));
  // Dependency completeness is unknown. Do not invent an all-files graph or skip
  // unchanged files merely because this snapshot happened to capture no callers.
  return {identity,snapshotId:snapshot.id,files};
}
export function prepareReviewHistory(snapshot,route,capturePolicy,{previous,outcomes,explicitDiffOnly=false}={}) {
  const identity=reviewHistoryIdentity(snapshot,route,capturePolicy);
  const manifest=reviewSourceManifest(snapshot,identity);
  if (!previous) {if(outcomes?.length)throw new Error('Finding outcomes require an owned prior review');return {identity,manifest};}
  if(!previous.ledger||!previous.manifest||previous.ledger.cycle>=3)throw new Error('Review-fix cycle cap reached or prior history unavailable; step back and reconsider');
  // Validate exact ledger identity and decisions without borrowing any conclusions.
  buildFindingLedger({snapshotId:snapshot.id,findings:[],files:[]},identity,{previous:previous.ledger,outcomes});
  const selection=buildIncrementalSelection(snapshot,{previousManifest:previous.manifest,currentManifest:manifest,explicitDiffOnly});
  return {identity,manifest,previous:previous.ledger,outcomes,incremental:selection.plan,selection};
}
export function finishReviewHistory(report,prepared) {
  const ledger=buildFindingLedger(report,prepared.identity,{...(prepared.previous?{previous:prepared.previous}:{}),...(prepared.outcomes?{outcomes:prepared.outcomes}:{})});
  return {ledger,manifest:prepared.manifest,...(prepared.incremental?{incremental:prepared.incremental}:{})};
}
