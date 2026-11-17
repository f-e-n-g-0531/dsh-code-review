import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepareWholeScope } from '../src/whole-scope-plan.mjs';
import { splitWholeBatch } from '../src/whole-batch-split.mjs';
import { initialInputBudget } from '../src/input-budget.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { retrievalRequest } from '../src/retrieval-loop.mjs';
import { modelWireBudget } from '../src/model-wire-budget.mjs';
import { focusedWholeReview } from '../src/whole-scope-input.mjs';
import { changeMap } from '../src/change-map.mjs';
import { measureChildInitialInput, buildReviewChildInitialEnvelope } from '../src/child-input-budget.mjs';
import { SNAPSHOT_TOOL_SCHEMA } from '../src/review-child-plugin.mjs';
import { wholeScopeGroups } from '../src/whole-scope-groups.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const body = Array.from({length: 500}, (_, i) => 'same repeated fragment ' + (i % 4) + '\r\n').join('');
const file = (id, path = id + '.txt') => ({ id, path, eligibility: 'reviewable', left: { text: body, hash: 'raw-old-' + id, revision: 'fixed-base' }, right: { text: body.slice(0, 6000) + 'changed\r\n' + body.slice(6000), hash: 'raw-new-' + id, revision: 'fixed-target' } });
const snapshot = files => ({ id: 'fixed-snapshot', files, context: [], rules: [] });
const plan = (s, options = {}) => prepareWholeScope(s, { instructions: 'rules stay', maxInputBytes: 2000000, ...options });
const bytes = (batch, scope) => initialInputBudget({input: batch.payload, instructions: batch.instructions, nativeOutputTools:true}, scope, Number.MAX_SAFE_INTEGER).bytes;

test('focused exact windows preserve repeated CRLF source coordinates, raw hashes and reader full snapshot', () => {
  const s = snapshot([file('f')]), original = structuredClone(s), scope = createRetrievalScope(s), catalog = scope.catalog();
  const full = plan(s, {scope}).batches[0], focused = plan(s, {scope, primaryInputMode:'focused'}).batches[0];
  assert.ok(bytes(focused,scope) < bytes(full,scope) / 2);
  const row = JSON.parse(focused.payload).reviews[0];
  assert.equal(row.primarySource.completeText, false);
  assert.equal(row.primarySource.completeEdits, true);
  assert.equal(row.file.left.text, undefined);
  assert.deepEqual(focused.changes.get('f'), changeMap(s.files[0].left.text,s.files[0].right.text));
  for (const window of row.sourceWindows) for (const side of ['old','new']) {
    const w = window[side], text = s.files[0][side === 'old' ? 'left' : 'right'].text;
    assert.equal(w.text, text.slice(w.startOffset,w.endOffset));
    assert.equal(w.start, (text.slice(0,w.startOffset).match(/\n/g) ?? []).length + 1);
    assert.equal(w.textHash, sha(text));
    assert.equal(w.hash, s.files[0][side === 'old' ? 'left' : 'right'].hash);
    assert.equal(w.sourceId,catalog.find(c=>c.side===side).id);
  }
  assert.deepEqual(scope.catalog(),catalog);
  assert.deepEqual(s,original);
  assert.doesNotMatch(focused.instructions,/reviews各成员file.left\/right及内联context\/rules已是本次批准的完整正文/);
  const actual = retrievalRequest({input:focused.payload,instructions:focused.instructions,nativeOutputTools:true},scope,[],{max:3,remaining:3});
  assert.equal(bytes(focused,scope),modelWireBudget(actual,Number.MAX_SAFE_INTEGER).bytes);
  assert.equal(plan(s,{scope,primaryInputMode:'focused',maxInputBytes:bytes(focused,scope)}).batches[0].id,focused.id);
});

test('all 35 identities including deletion survive; excluded and blocked never return', () => {
  const files = Array.from({length:35},(_,i)=>file('f'+i));
  files[10].right = {text:'',hash:'deleted'}; files[10].rightExists=false; files[10].status='deleted';
  const s = snapshot([...files,{...file('excluded'),eligibility:'excluded'},{...file('blocked'),eligibility:'blocked'}]);
  const out = plan(s,{primaryInputMode:'focused',relationAwareGrouping:true});
  assert.deepEqual(new Set(out.batches.flatMap(b=>b.fileIds)),new Set(files.map(f=>f.id)));
  assert.equal(out.batches.flatMap(b=>b.fileIds).length,35);
  const row = JSON.parse(out.batches[0].payload).reviews.find(r=>r.fileId==='f10');
  assert.equal(row.file.rightExists,false); assert.equal(row.file.status,'deleted');
  assert.equal(row.file.right.lineCount,0);
  assert.equal(row.sourceWindows[0].new.count,0);
});

test('relation grouping stable under reordered input, header/implementation adjacency precedes capacity split', () => {
  const files = [file('a','src/A.cpp'),file('z','src/A.h'),file('b','src/B.cpp'),file('y','src/B.h')];
  const s = snapshot(files), options = {relationAwareGrouping:true};
  const all = plan(s,options), reverse = plan(snapshot([...files].reverse()),options);
  assert.equal(all.batches[0].id,reverse.batches[0].id);
  assert.deepEqual(all.grouping.groups.map(g=>g.fileIds),[['a','z'],['b','y']]);
  const halves = splitWholeBatch(all.batches[0]);
  const limit = Math.max(...halves.map(b=>bytes(b))) + 100;
  const out = plan(s,{...options,maxInputBytes:limit});
  assert.deepEqual(out.batches.map(b=>b.fileIds),[['a','z'],['b','y']]);
  assert.ok(out.batches.every(b=>bytes(b)<=limit));
  assert.ok(out.grouping.groups.every(g=>g.batchIds.length===1));
  // Force a relation pair to split, retaining the link and explicit incomplete membership.
  const oneLimit = Math.max(...splitWholeBatch(halves[0]).map(b=>bytes(b))) + 100;
  const split = plan(snapshot(files.slice(0,2)),{...options,maxInputBytes:oneLimit});
  assert.equal(split.batches.length,2);
  assert.equal(split.grouping.links[0].crossBatch,true);
  assert.ok(split.batches.every(b=>b.groupScope.groups[0].completeMembers===false));
});

test('recovery split keeps focused provenance and reprojects incomplete logical groups', () => {
  const s = snapshot([file('a','A.cpp'),file('b','A.h')]);
  const batch = plan(s,{primaryInputMode:'focused',relationAwareGrouping:true}).batches[0];
  const split = splitWholeBatch(batch);
  for (const child of split) {
    const payload = JSON.parse(child.payload);
    assert.equal(child.primaryInputMode,'focused'); assert.equal(payload.primaryInputMode,'focused');
    assert.equal(child.groupScope.groups[0].completeMembers,false);
    assert.equal(child.groupScope.links[0].crossBatch,true);
    const old = JSON.parse(batch.payload).reviews.find(r=>r.fileId===child.fileIds[0]);
    assert.deepEqual(payload.reviews[0],old);
    assert.deepEqual(child.changes.get(old.fileId),batch.changes.get(old.fileId));
  }
});

for (const vcs of ['git','svn']) test(vcs+' fixed provenance unchanged, shared rules and requirements preserved', () => {
  const s = {...snapshot([file('f')]),history:{vcs,base:'fixed-base',target:'fixed-target'},rules:[{path:'RULES.md',text:'must keep'}],businessRequirement:'must keep requirement'};
  const original=structuredClone(s), scope=createRetrievalScope(s);
  const batch=plan(s,{scope,primaryInputMode:'focused'}).batches[0], value=JSON.parse(batch.payload);
  assert.equal(value.reviews[0].file.left.revision,'fixed-base');
  assert.equal(value.reviews[0].file.right.revision,'fixed-target');
  assert.deepEqual(value.rules,s.rules); assert.equal(value.businessRequirement,s.businessRequirement);
  assert.deepEqual(s,original);
});

test('excluded competing path remains an ambiguity blocker without restoring it to review scope', () => {
  const a=file('a','src/a.mjs'), b=file('b','src/b.mjs');
  a.right.text='import { call } from "./b";\ncall();\n';
  b.right.text='export function call() {}\n';
  const excluded={...file('x','src/b.js'),eligibility:'excluded'};
  const out=plan(snapshot([a,b,excluded]),{relationAwareGrouping:true});
  assert.ok(!out.grouping.links.some(link=>link.from==='a'&&link.to==='b'));
  assert.ok(out.batches.every(batch=>!batch.fileIds.includes('x')));
});

test('logical components larger than twenty are not split before wire capacity', () => {
  const files = Array.from({length:35},(_,i)=>file('f'+i,'src/f'+i+'.mjs'));
  for (let i=0;i<34;i++) files[i].right.text = 'import "./f'+(i+1)+'.mjs";\n'+files[i].right.text;
  const groups=wholeScopeGroups(files);
  assert.equal(groups.groups.length,1); assert.equal(groups.groups[0].fileIds.length,35);
});

test('migration old/new entry and callers remain one logical navigation group', () => {
  const fn=(name,body)=>'export function '+name+'(state) {\n'+body+'\n}\n';
  const publicOld=fn('mutate','  if (!state.allowed) { return; }\n  state.value++;');
  const publicNew=fn('mutate','  state.value++;');
  const preloadOld=fn('preload','  state.ready = true;');
  const preloadNew='import { mutate } from "./public.mjs";\n'+fn('preload','  if (!state.allowed) { return; }\n  mutate(state);');
  const caller='import { mutate } from "./public.mjs";\n'+fn('run','  mutate(state);');
  const s=snapshot([['a','public.mjs',publicOld,publicNew],['b','preload.mjs',preloadOld,preloadNew],['c','caller.mjs',caller,caller]].map(([id,path,old,next])=>({...file(id,path),left:{text:old},right:{text:next}})));
  const out=plan(s,{relationAwareGrouping:true});
  assert.equal(out.grouping.groups.length,1);
  assert.deepEqual(new Set(out.grouping.groups[0].fileIds),new Set(['a','b','c']));
  assert.ok(out.grouping.links.some(link=>link.reasons.includes('migration-route')));
});

test('child focused exact initial envelope and declared reserve use the same planner boundary', () => {
  const s=snapshot([file('f')]),scope=createRetrievalScope(s),options={scope,primaryInputMode:'focused',childTransport:true,hostReserveBytes:1234};
  const batch=plan(s,options).batches[0],request={input:batch.payload,instructions:batch.instructions};
  const measured=measureChildInitialInput(request,scope,{maxInputBytes:2000000,hostReserveBytes:1234,snapshotTool:SNAPSHOT_TOOL_SCHEMA});
  assert.equal(measured.requiredBytes,Buffer.byteLength(JSON.stringify(buildReviewChildInitialEnvelope(request,scope,{snapshotTool:SNAPSHOT_TOOL_SCHEMA})))+1234);
  assert.equal(plan(s,{...options,maxInputBytes:measured.requiredBytes}).batches[0].id,batch.id);
  assert.equal(plan(s,{...options,maxInputBytes:measured.requiredBytes-1}).oversized[0].requiredBytes,measured.requiredBytes);
});

test('full default remains byte-identical to explicit full and focused unsafe diff/project fallback is explicit', () => {
  const s=snapshot([file('f')]);
  assert.deepEqual(plan(s),plan(s,{primaryInputMode:'full',relationAwareGrouping:false}));
  for (const changes of [{status:'limited',edits:[],hunks:[]}, {status:'unchanged',edits:[],hunks:[]}]) {
    const row=focusedWholeReview({file:s.files[0],fileId:'f',snapshotId:s.id,changes});
    assert.equal(row.primarySource.mode,'full'); assert.equal(row.file.left.text,body);
  }
  const project=plan({...s,projectScope:{}},{primaryInputMode:'focused'});
  assert.equal(JSON.parse(project.batches[0].payload).reviews[0].primarySource.fallback,'project-current-source');
  assert.throws(()=>plan(s,{primaryInputMode:'bad'})); assert.throws(()=>plan(s,{relationAwareGrouping:1}));
});
