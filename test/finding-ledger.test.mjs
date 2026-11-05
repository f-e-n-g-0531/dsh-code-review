import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFindingLedger, planIncrementalReview } from '../src/finding-ledger.mjs';
import { validateResponse } from '../src/review.mjs';
const identity = { repository: 'git:repo-A', route: 'working-copy:all', rulesHash: 'a'.repeat(64), requirementPolicyHash: 'b'.repeat(64) };
const finding = (overrides = {}) => ({ fileId: 'f1', path: 'src/a.mjs', severity: 'high', title: 'same title', evidence: 'unchecked value', trigger: 'null input', impact: 'crash', suggestion: 'guard', anchor: { kind: 'line', side: 'new', start: 1, end: 1, snippet: 'run(value);' }, ...overrides });
const report = (findings = [finding()], snapshotId = 's1') => ({ schemaVersion: 1, snapshotId, status: 'completed', files: [{ fileId: 'f1', path: 'src/a.mjs', status: 'completed' }], findings });
const build = (r = report(), options = {}, id = identity) => buildFindingLedger(r, id, options);
const metadata = files => ({ identity, snapshotId: 's', files });
const source = (path, hash = 'c'.repeat(64), dependencies = []) => ({ path, hash, dependencies });

test('real validateResponse output accepted; source and receipts never copied, input immutable', () => {
  const file = { id: 'f1', path: 'src/a.mjs', left: {text:'run(value);'}, right:{text:'run(value);'}, properties:[] };
  const result = validateResponse({findings:[finding()],limitations:[]}, file);
  result.findings[0].verification = { status:'completed', verdict:'supported', evidence:[{receiptId:'SECRET_RECEIPT',text:'SECRET_SOURCE'}] };
  const r = report(result.findings); const before = structuredClone(r);
  const ledger = build(r);
  assert.deepEqual(r,before);
  const json = JSON.stringify(ledger);
  for (const secret of ['SECRET_RECEIPT','SECRET_SOURCE','run(value);','supported','verification','unchecked value']) assert.equal(json.includes(secret),false);
  assert.equal(Object.isFrozen(ledger.findings[0].humanDecisions),true);
  assert.throws(()=>ledger.findings.push({}),TypeError);
});

test('line movement, title/severity changes and duplicate observations keep stable defect id', () => {
  const first = build();
  const moved = finding({title:'renamed',severity:'low', anchor:{kind:'line',side:'new',start:900,end:900,snippet:'run(value);'}});
  const next = build(report([moved,moved],'s2'),{previous:first});
  assert.equal(next.findings.length,1);
  assert.equal(next.findings[0].id,first.findings[0].id);
  assert.equal(next.findings[0].observation,'repeated');
  assert.deepEqual(next.findings[0].findingIndices,[0,1]);
  assert.equal(first.findings[0].observation,'new');
});

test('same title/path never merges different causes, exact snippets, sides, or interaction refs', () => {
  const variants = [finding(),finding({trigger:'different cause'}),finding({anchor:{kind:'line',side:'old',snippet:'run(value);'}}),finding({anchor:{kind:'line',side:'new',snippet:'other();'}}),finding({interaction:{editRefs:[{fileId:'f2',editId:'e1'}]}})];
  assert.equal(build(report(variants)).findings.length,5);
  assert.notEqual(build().findings[0].id,build(report(),{}, {...identity,repository:'git:other'}).findings[0].id);
});

test('property exact identity repeats; file anchors remain unmatchable across snapshots', () => {
  for (const anchor of [{kind:'property',name:'svn:executable'},{kind:'file'}]) {
    const first = build(report([finding({anchor})]));
    const next = build(report([finding({anchor})],'s2'),{previous:first});
    if (anchor.kind === 'property') assert.equal(next.findings[0].observation,'repeated');
    else { assert.equal(next.findings.length,2); assert.deepEqual(next.findings.map(f=>f.observation),['not-observed','new']); }
  }
});

test('missing finding is not-observed, never automatically fixed or refuted', () => {
  const first = build(); const next = build(report([],'s2'),{previous:first});
  assert.equal(next.findings[0].observation,'not-observed');
  assert.deepEqual(next.findings[0].humanDecisions,[]);
  assert.deepEqual(next.findings[0].findingIndices,[]);
});

test('explicit dispositions require known ids and reasons; fixed claim does not hide fresh evidence', () => {
  const first = build(); const id=first.findings[0].id;
  for (const decision of ['fixed','refuted','intentional','deferred']) {
    const next=build(report(),{previous:first,outcomes:[{id,decision,reason:'human statement'}]});
    assert.equal(next.findings[0].observation,'repeated');
    assert.deepEqual(next.findings[0].humanDecisions,[{decision,reason:'human statement',cycle:2}]);
  }
  for (const outcomes of [[{id:'unknown',decision:'fixed',reason:'yes'}],[{id,decision:'fixed',reason:''}],[{id,decision:'approved',reason:'yes'}],[{id,decision:'fixed',reason:'yes',verified:true}],[{id,decision:'fixed',reason:'yes'},{id,decision:'fixed',reason:'yes'}]]) assert.throws(()=>build(report(),{previous:first,outcomes}));
});

test('bounded chain max3 asks step-back and rejects fourth, including same snapshot retries', () => {
  const first=build(); const second=build(report(),{previous:first}); const third=build(report(),{previous:second});
  assert.equal(third.cycle,3); assert.equal(third.nextAction,'step-back'); assert.equal(third.chainOrigin,first.chainOrigin);
  assert.throws(()=>build(report(),{previous:third}),/cycle cap/);
});

test('strict identities reject cross-repo/route/rules/policy and hostile extra fields', () => {
  const previous=build();
  for (const key of Object.keys(identity)) assert.throws(()=>build(report(),{previous},{...identity,[key]:key.endsWith('Hash')?'f'.repeat(64):'other'}),/identity mismatch/);
  assert.throws(()=>build(report(),{}, {...identity,approved:true}));
  assert.throws(()=>build(report(),{previous,receiptId:'old'}));
  const getter={...identity}; Object.defineProperty(getter,'repository',{get(){throw new Error('getter executed');}});
  assert.throws(()=>build(report(),{},getter),/invalid fields/);
  assert.throws(()=>build(report(),{previous:{...previous,verified:true}}));
  const altered=structuredClone(previous); altered.findings[0].claimHash='f'.repeat(64);
  assert.throws(()=>build(report(),{previous:altered}),/fingerprint/);
  const duplicate=structuredClone(previous);duplicate.findings.push(duplicate.findings[0]);
  assert.throws(()=>build(report(),{previous:duplicate}));
});

test('unique files mapping fallback includes batch identity; ambiguous or invalid paths fail', () => {
  const f=finding();delete f.path;
  assert.equal(build(report([f])).findings[0].path,'src/a.mjs');
  const r=report([f]);r.files.push({fileId:'f1',path:'src/b.mjs'});
  assert.throws(()=>build(r));
  r.findings[0].batchSnapshotId='b';r.files[0].batchSnapshotId='b';r.files[1].batchSnapshotId='c';
  assert.equal(build(r).findings[0].path,'src/a.mjs');
  for (const path of ['../x','/x','C:/x','src/../x','a\\b']) assert.throws(()=>build(report([finding({path})])));
});

test('canonical SVN root permits property/file findings and manifests, never root line anchors', () => {
  for (const anchor of [{kind:'property',name:'svn:ignore'},{kind:'file'}]) {
    const first=build(report([finding({path:'.',anchor})]));
    assert.equal(first.findings[0].path,'.');
    assert.doesNotThrow(()=>build(report([],'s2'),{previous:first}));
  }
  assert.throws(()=>build(report([finding({path:'.'})])),/root findings/);
  const bad=structuredClone(build(report([finding({path:'.',anchor:{kind:'property',name:'svn:ignore'}})])));
  bad.findings[0].side='new';
  assert.throws(()=>build(report(),{previous:bad}),/root findings/);
  const root=metadata([source('.')]);
  assert.deepEqual(planIncrementalReview(root,root).unchangedNavigationPaths,['.']);
  const dep=metadata([source('.'),source('a','d'.repeat(64),[{path:'.',hash:'c'.repeat(64)}])]);
  assert.deepEqual(planIncrementalReview(dep,dep).unchangedNavigationPaths,['.','a']);
  for (const path of ['..','./','./a','a/./b','a/../b','../a']) {
    assert.throws(()=>build(report([finding({path,anchor:{kind:'property',name:'svn:ignore'}})])));
    assert.throws(()=>planIncrementalReview(metadata([source(path)]),root));
  }
});

test('unchanged exact source and complete dependency hashes are navigation only', () => {
  const prev=metadata([source('a'),source('b','d'.repeat(64),[{path:'a',hash:'c'.repeat(64)}])]);
  const result=planIncrementalReview(prev,structuredClone(prev));
  assert.deepEqual(result.freshReviewPaths,[]);assert.deepEqual(result.unchangedNavigationPaths,['a','b']);
  assert.equal(result.coverage,false); assert.equal(result.requiresFreshEvidence,true);assert.equal(Object.isFrozen(result),true);
});

test('changed unknown removed dependency invalidates transitive callers, no false unchanged', () => {
  const prev=metadata([source('a'),source('b','d'.repeat(64),[{path:'a',hash:'c'.repeat(64)}]),source('z')]);
  const current=metadata([source('a','e'.repeat(64)),source('b','d'.repeat(64),[{path:'a',hash:'e'.repeat(64)}]),source('new')]);
  assert.deepEqual(planIncrementalReview(prev,current).freshReviewPaths,['a','b','new']);
  assert.deepEqual(planIncrementalReview(prev,current).removedPaths,['z']);
  for (const file of [{path:'a',hash:'c'.repeat(64)},{path:'a',dependencies:[]},source('a','c'.repeat(64),[{path:'missing',hash:'f'.repeat(64)}])]) {
    const m=metadata([file]);assert.deepEqual(planIncrementalReview(m,m).freshReviewPaths,['a']);
  }
});

test('dependency cycles terminate and unknown member invalidates entire cycle', () => {
  const a=source('a','c'.repeat(64),[{path:'b',hash:'d'.repeat(64)}]);
  const b=source('b','d'.repeat(64),[{path:'a',hash:'c'.repeat(64)}]);
  const m=metadata([a,b]);assert.deepEqual(planIncrementalReview(m,m).unchangedNavigationPaths,['a','b']);
  const unknown=structuredClone(m);delete unknown.files[1].dependencies;
  assert.deepEqual(planIncrementalReview(m,unknown).freshReviewPaths,['a','b']);
});

test('planner identity/unknown metadata fields/hash shape/duplicates fail closed', () => {
  const m=metadata([source('a')]);
  for(const bad of [{...m,identity:{...identity,route:'other'}},{...m,verified:true},metadata([source('a','not-hash')]),metadata([source('a'),source('a')]),metadata([{...source('a'),supported:true}])]) assert.throws(()=>planIncrementalReview(m,bad));
});
