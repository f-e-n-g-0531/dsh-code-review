import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIncrementalSelection, incrementalFileHash, incrementalContextHash } from '../src/incremental-review.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
const identity={repository:'repo',route:'working',rulesHash:'a'.repeat(64),requirementPolicyHash:'b'.repeat(64)};
const file=(id,text)=>({id,path:id+'.mjs',eligibility:'reviewable',left:{text:'old '+text},right:{text},properties:[]});
function setup() {
  const previous={id:'before',files:[file('a','a'),file('b','b'),file('c','c')],context:[],rules:[]};
  const current=structuredClone(previous);current.id='after';current.files[0].right.text='changed';
  const manifest=s=>({identity,snapshotId:s.id,files:s.files.map(f=>({path:f.path,hash:incrementalFileHash(f),dependencies:[]}))});
  const previousManifest=manifest(previous),currentManifest=manifest(current);
  previousManifest.files[1].dependencies=[{path:'a.mjs',hash:previousManifest.files[0].hash}];
  currentManifest.files[1].dependencies=[{path:'a.mjs',hash:currentManifest.files[0].hash}];
  const dependencyGraph={status:'complete',repositoryWide:true,previousSnapshotId:previous.id,currentSnapshotId:current.id,previousContextHash:incrementalContextHash(previous),currentContextHash:incrementalContextHash(current)};
  return {previous,current,options:{previousManifest,currentManifest,dependencyGraph,capturePolicyUnchanged:true}};
}
test('explicit known complete graph narrows only unchanged independent primary and preserves sources',()=>{
  const {current,options}=setup(),original=structuredClone(current);
  const result=buildIncrementalSelection(current,options);
  assert.deepEqual(result.plan.primaryPaths,['a.mjs','b.mjs']);
  assert.deepEqual(result.plan.unreviewedPaths,['c.mjs']);
  assert.equal(result.plan.requiredReportStatus,'partial');assert.equal(result.plan.coverage,false);
  assert.deepEqual(result.plan.excludedRecords,[{fileId:'c',path:'c.mjs',status:'excluded',reason:'incremental-unchanged-not-reviewed'}]);
  assert.deepEqual(current,original);assert.equal(result.retrievalSnapshot,current);
  for(let i=0;i<current.files.length;i++) {
    assert.equal(result.reviewSnapshot.files[i].left,current.files[i].left);
    assert.equal(result.reviewSnapshot.files[i].right,current.files[i].right);
  }
  assert.equal(result.reviewSnapshot.id,current.id);
  const catalog=createRetrievalScope(result.retrievalSnapshot).catalog();
  assert.equal(catalog.filter(s=>s.path==='c.mjs').length,2);
  assert.equal(createRetrievalScope(result.reviewSnapshot).catalog().some(s=>s.path==='c.mjs'),false);
});
test('unknown graph or policy defaults to all fresh, even supplied isolated empty deps',()=>{
  for(const change of [o=>delete o.dependencyGraph,o=>o.dependencyGraph.status='unknown',o=>o.dependencyGraph.repositoryWide=false,o=>delete o.capturePolicyUnchanged,o=>o.capturePolicyUnchanged=false,o=>delete o.currentManifest.files[0].dependencies]) {
    const {current,options}=setup();change(options);
    const r=buildIncrementalSelection(current,options);
    assert.deepEqual(r.plan.primaryPaths,['a.mjs','b.mjs','c.mjs']);assert.deepEqual(r.plan.unreviewedPaths,[]);assert.equal(r.plan.requiredReportStatus,null);
  }
});
test('context/rule/requirement changes force full despite complete graph',()=>{
  const {current,options}=setup();current.context=[{path:'ctx.mjs',text:'fresh'}];options.dependencyGraph.currentContextHash=incrementalContextHash(current);
  assert.deepEqual(buildIncrementalSelection(current,options).plan.unreviewedPaths,[]);
});
test('both source sides properties and provenance hashed; eligibility changes do not invent diffs',()=>{
  const original=file('x','same'),h=incrementalFileHash(original);
  for(const change of [f=>f.left.text='different',f=>f.properties.push({name:'mode',value:'new'}),f=>f.rightExists=false,f=>f.svnSources={old:{revision:2}}]) {const f=structuredClone(original);change(f);assert.notEqual(incrementalFileHash(f),h);}
  assert.equal(incrementalFileHash({...original,id:'other',eligibility:'excluded',reason:'skip'}),h);
});
test('bound identity inventory exact source and graph snapshots reject hostile metadata',()=>{
  for(const change of [o=>o.currentManifest.snapshotId='wrong',o=>o.currentManifest.files.pop(),o=>o.currentManifest.files[0].hash='f'.repeat(64),o=>o.previousManifest.identity={...identity,repository:'other'},o=>o.dependencyGraph.currentSnapshotId='wrong',o=>o.dependencyGraph.currentContextHash='f'.repeat(64),o=>o.dependencyGraph.approved=true,o=>o.priorBody='forbidden',o=>o.capturePolicyUnchanged='yes']) {
    const {current,options}=setup();change(options);assert.throws(()=>buildIncrementalSelection(current,options));
  }
});
test('removed paths metadata retained, missing graph dependency prevents all skipping',()=>{
  const {current,options}=setup();options.previousManifest.files.push({path:'removed.mjs',hash:'e'.repeat(64),dependencies:[]});
  const result=buildIncrementalSelection(current,options);assert.deepEqual(result.plan.removedPaths,['removed.mjs']);
  options.currentManifest.files[0].dependencies=[{path:'missing.mjs',hash:'e'.repeat(64)}];
  assert.deepEqual(buildIncrementalSelection(current,options).plan.unreviewedPaths,[]);
});
test('blocked and previously excluded records never promoted or overwritten',()=>{
  const {current,options}=setup();current.files[2].eligibility='blocked';current.files[2].reason='sensitive';
  const r=buildIncrementalSelection(current,options);
  assert.equal(r.reviewSnapshot.files[2].eligibility,'blocked');assert.equal(r.reviewSnapshot.files[2].reason,'sensitive');assert.deepEqual(r.plan.unreviewedPaths,[]);
});
