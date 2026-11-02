import test from 'node:test';
import assert from 'node:assert/strict';
import { stageKey, prepareStageGenerations, MAX_STAGE_LIMITATIONS } from '../src/review-stage-state.mjs';
import { validateFindings as actualValidateFindings } from '../src/review.mjs';
import { reviewChangeMap } from '../src/review-change-map.mjs';
import { hash } from '../src/content.mjs';
import { validateAttribution } from '../src/attribution.mjs';
function validateFindings(g, file) {
  const findings=g.findings.map(raw=>{const result={fileId:file.id,path:file.path,severity:raw.severity,anchor:{...raw.anchor},attribution:validateAttribution(raw.attribution,file)};for(const key of ['title','evidence','trigger','impact','suggestion'])result[key]=raw[key];return {id:hash(JSON.stringify(result)),...result};});
  return {findings,limitations:[...g.limitations]};
}
import { changeMap } from '../src/change-map.mjs';
import { changeWindows } from '../src/change-windows.mjs';
import { sourceSegments } from '../src/source-segments.mjs';

const source = (id = 'f') => ({ id, path: id + '.js', eligibility: 'reviewable', properties: [], left: { text: 'old();\r\n' }, right: { text: 'new();\r\n' } });
const snapshot = () => ({ id: 'snapshot', files: [source(), source('g')] });
const rawFinding = (id = 'f') => ({ fileId: id, severity: 'high', title: 'Unchecked state', evidence: 'New call', trigger: 'invalid input', impact: 'invalid state', suggestion: 'Restore guard', anchor: { kind: 'line', side: 'new', start: 1, end: 1, snippet: 'new();' }, attribution: { editIds: ['e1'], properties: [], beforeBehavior: 'guarded', afterBehavior: 'unguarded', reason: 'guard removed' } });
function record(extra = {}, generation = { findings: [rawFinding()], limitations: ['Only approved scope'] }) {
  const descriptor = { fileId: 'f', phase: 'primary', round: 1, windowIds: [], ...extra };
  return { key: stageKey(descriptor.fileId, descriptor), ...descriptor, generation };
}
const prepare = records => prepareStageGenerations(snapshot(), records);
const rejects = fn => assert.throws(fn);

test('stable unambiguous stage identity is ordered by windows and separated by round phase owner and group', () => {
  assert.equal(stageKey('f', { phase: 'primary', windowIds: ['h2', 'h1'] }), stageKey('f', { phase: 'primary', round: 1, windowIds: ['h1', 'h2'] }));
  const values = [record().key, record({round:2}).key, record({fileId:'g'}).key, record({windowIds:['h1']}).key, record({phase:'window-synthesis',windowIds:['h1','h2']}).key,record({phase:'file-interaction',groupId:'g1'}).key];
  assert.equal(new Set(values).size, values.length);
  for (const descriptor of [{phase:'verification'}, {phase:'primary',round:0}, {phase:'primary',round:51}, {phase:'primary',windowIds:['h1','h1']}, {phase:'file-interaction'}, {phase:'primary',groupId:''}]) rejects(() => stageKey('f', descriptor));
});

test('normalized validateResponse findings round-trip canonically without importing review into production helper', () => {
  const s = snapshot(), g = validateFindings({findings:[rawFinding()],limitations:['Only approved scope']},s.files[0]);
  const [saved] = prepareStageGenerations(s,[record({},g)]);
  assert.deepEqual(saved.generation,g);assert.equal(saved.needsFreshProvenance,false);assert.equal(saved.path,'f.js');assert.equal(saved.round,1);
  assert.notEqual(saved.generation,g);saved.generation.findings[0].title='changed';assert.equal(g.findings[0].title,'Unchecked state');
});

test('new verifier must get fresh receipts: all historical verification regression and read audits stripped at every supported level', () => {
  const g = validateFindings({findings:[rawFinding()],limitations:[]},source());
  Object.assign(g.findings[0],{verification:{status:'completed',verdict:'supported',evidence:[{receiptId:'OLD_SECRET_RECEIPT'}]},regression:{classification:'introduced'},priorRun:{jobId:'old'},receiptId:'OLD_SECRET_RECEIPT',receipts:['OLD_SECRET_RECEIPT'],retrievalAudit:[{stage:'retrieved-locally',text:'OLD_SECRET_BODY'}],reviewRound:2});
  Object.assign(g,{receipts:['OLD_SECRET_RECEIPT'],verification:{status:'completed'}});
  const r=record({round:2},g);Object.assign(r,{retrievalAudit:[{text:'OLD_SECRET_BODY'}],receipts:['OLD_SECRET_RECEIPT'],verification:{status:'completed'}});
  const [saved]=prepare([r]);assert.doesNotMatch(JSON.stringify(saved),/OLD_SECRET|verification|regression|retrievalAudit|receiptId|receipts|reviewRound|priorRun/);
  assert.equal(saved.generation.findings[0].id,g.findings[0].id);assert.equal(saved.generation.findings[0].attribution.causality,'unverified');
});

test('primary records across canonical windows and multiple rounds remain distinct and serializable', () => {
  const s=snapshot();const before=Array.from({length:30},(_,i)=>'line'+i);const after=[...before];after[1]='new();';after[26]='new();';s.files[0].left.text=before.join('\n');s.files[0].right.text=after.join('\n');
  const windows=sourceSegments(changeWindows(s.files[0],changeMap(s.files[0].left.text,s.files[0].right.text)));
  assert.equal(windows.length,2);
  const records=[];for(const round of [1,2])for(const [i,w] of windows.entries()) {const f=rawFinding();f.anchor.start=f.anchor.end=i===0?2:27;f.attribution.editIds=[w.editIds[0]];records.push(record({round,windowIds:[w.id]},{findings:[f],limitations:[]}));}
  const saved=prepareStageGenerations(s,records);assert.equal(saved.length,4);assert.equal(new Set(saved.map(r=>r.key)).size,4);
  assert.deepEqual(prepareStageGenerations(s,JSON.parse(JSON.stringify(saved))),saved);
  assert.ok(saved.every(r=>!r.needsFreshProvenance));
});

test('unknown window and finding outside selected window fail even with matching approved file and text', () => {
  rejects(()=>prepare([record({windowIds:['bogus']})]));
  const s=snapshot(),lines=Array.from({length:40},(_,i)=>'line'+i),right=[...lines];right[1]='new();';right[35]='new();';s.files[0].left.text=lines.join('\n');s.files[0].right.text=right.join('\n');
  const windows=sourceSegments(changeWindows(s.files[0],changeMap(s.files[0].left.text,s.files[0].right.text)));
  const f=rawFinding();f.anchor.start=f.anchor.end=36;f.attribution.editIds=[windows[1].editIds[0]];
  rejects(()=>prepareStageGenerations(s,[record({windowIds:[windows[0].id]},{findings:[f],limitations:[]})]));
});

test('foreign file path blocked or duplicate snapshot identity and forged stage keys fail closed', () => {
  for(const r of [record({path:'../outside.js'}),record({fileId:'unknown'}),{...record(),key:'forged'},record({}, {findings:[{...rawFinding(),fileId:'g'}],limitations:[]})]) rejects(()=>prepare([r]));
  const blocked=snapshot();blocked.files[0].eligibility='blocked';rejects(()=>prepareStageGenerations(blocked,[record()]));
  const duplicate=snapshot();duplicate.files.push({...source(),eligibility:'excluded'});rejects(()=>prepareStageGenerations(duplicate,[record()]));
  rejects(()=>prepare([record(),record()]));
});

test('tampered anchor ranges snippets side receipt source extras and canonical edit references rejected', () => {
  for(const patch of [{start:0},{end:2},{side:'context'},{snippet:'different'},{receiptId:'old'},{sourceId:'foreign'}]) {const f=rawFinding();Object.assign(f.anchor,patch);rejects(()=>prepare([record({}, {findings:[f],limitations:[]})]));}
  for(const patch of [{editIds:['e999']},{editIds:['e1','e1']},{properties:['not-changed']},{status:'references-and-reads-validated'}]){const f=rawFinding();Object.assign(f.attribution,patch);rejects(()=>prepare([record({}, {findings:[f],limitations:[]})]));}
  const g=validateFindings({findings:[rawFinding()],limitations:[]},source());g.findings[0].id='forged';rejects(()=>prepare([record({},g)]));
});

test('missing attribution remains missing never fabricated as accepted change proof', () => {
  const f=rawFinding();delete f.attribution;const [saved]=prepare([record({}, {findings:[f],limitations:[]})]);
  assert.deepEqual(saved.generation.findings[0].attribution,{status:'missing',causality:'unverified'});assert.deepEqual(prepare([saved]),[saved]);
});

test('changed property and file anchors normalize while unchanged properties reject', () => {
  const s=snapshot();s.files[0].properties=[{name:'mode',old:'a',new:'b'},{name:'same',old:'a',new:'a'}];
  for(const anchor of [{kind:'file'},{kind:'property',name:'mode'}]){const f=rawFinding();f.anchor=anchor;assert.equal(prepareStageGenerations(s,[record({}, {findings:[f],limitations:[]})]).length,1);}
  const f=rawFinding();f.anchor={kind:'property',name:'same'};rejects(()=>prepareStageGenerations(s,[record({}, {findings:[f],limitations:[]})]));
});

test('project primary retains current-source-only attribution and rejects historical anchors', () => {
  const s=snapshot();s.files[0].reviewMode='project';const f=rawFinding();delete f.attribution;
  const [saved]=prepareStageGenerations(s,[record({}, {findings:[f],limitations:[]})]);assert.deepEqual(saved.generation.findings[0].attribution,{status:'not-applicable',causality:'current-source-only'});
  f.anchor.side='old';f.anchor.snippet='old();';rejects(()=>prepareStageGenerations(s,[record({}, {findings:[f],limitations:[]})]));
});

test('interaction history never retains read-validated status and always requires fresh provenance', () => {
  const f=rawFinding();f.interaction={status:'references-and-reads-validated',causality:'unverified',editRefs:[{fileId:'f',editId:'e1'},{fileId:'g',editId:'e1'}]};
  const [saved]=prepare([record({phase:'file-interaction',groupId:'g1'}, {findings:[f],limitations:[]})]);
  assert.equal(saved.needsFreshProvenance,true);assert.equal(saved.generation.findings[0].interaction.status,'references-validated');assert.doesNotMatch(JSON.stringify(saved),/reads-validated|receipt/);assert.deepEqual(prepare([saved]),[saved]);
  f.interaction.editRefs[1].editId='e404';rejects(()=>prepare([record({phase:'file-interaction',groupId:'g1'},{findings:[f],limitations:[]})]));
});

test('synthesis records require canonical windows and cannot mark provenance completed', () => {
  rejects(()=>prepare([record({phase:'window-synthesis'},{findings:[],limitations:[]})]));
  const f=source(),windows=sourceSegments(changeWindows(f,changeMap(f.left.text,f.right.text)));
  const [saved]=prepare([record({phase:'window-synthesis',windowIds:windows.map(w=>w.id),needsFreshProvenance:false},{findings:[],limitations:[]})]);assert.equal(saved.needsFreshProvenance,true);
});

test('precise schema size caps and bounded counts reject excess without silent omission', () => {
  for(const maxBytes of [0,-1,Infinity,1.5,8*1024*1024+1])rejects(()=>prepareStageGenerations(snapshot(),[],{maxBytes}));
  rejects(()=>prepareStageGenerations(snapshot(),[record()],{maxBytes:10}));
  for(const r of [{...record(),unknown:true},record({}, {findings:[],limitations:[],status:'completed'}),record({}, {findings:Array.from({length:51},rawFinding),limitations:[]}),record({}, {findings:[],limitations:['']}),record({}, {findings:[],limitations:Array(103).fill('limit')})])rejects(()=>prepare([r]));
  const f=rawFinding();f.reviewRound=2;rejects(()=>prepare([record({}, {findings:[f],limitations:[]})]));
});

test('private imports never execute accessor toJSON or prototype hooks and reject cycles', () => {
  let executed=false;const r=record();Object.defineProperty(r.generation,'findings',{enumerable:true,get(){executed=true;return[];}});rejects(()=>prepare([r]));assert.equal(executed,false);
  const json=record();json.toJSON=()=>{executed=true;return{};};rejects(()=>prepare([json]));assert.equal(executed,false);
  const cycle=record();cycle.generation.receipts=[cycle];rejects(()=>prepare([cycle]));
  const proto=record();proto.generation=Object.assign(Object.create({findings:[]}),{limitations:[]});rejects(()=>prepare([proto]));
});

test('additional prepared-scope validator is synchronous fail-closed and receives no past receipt', () => {
  let called=0;const out=prepareStageGenerations(snapshot(),[record()],{validateGeneration(g,file,descriptor){called++;assert.equal(file.id,'f');assert.equal(descriptor.phase,'primary');assert.equal(g.findings[0].verification,undefined);}});assert.equal(called,1);assert.equal(out.length,1);
  rejects(()=>prepareStageGenerations(snapshot(),[record()],{validateGeneration:()=>false}));rejects(()=>prepareStageGenerations(snapshot(),[record()],{validateGeneration:()=>Promise.resolve(true)}));
});

test('host-only merged limitation cap accepts 102 but model protocol remains bounded at 50', () => {
  assert.equal(MAX_STAGE_LIMITATIONS, 102);
  const limits = Array.from({ length: 102 }, (_, i) => 'bounded host limitation ' + i);
  const [saved] = prepare([record({}, { findings: [], limitations: limits })]);
  assert.deepEqual(saved.generation.limitations, limits);
  assert.deepEqual(prepare([saved]), [saved]);
  rejects(() => prepare([record({}, { findings: [], limitations: [...limits, 'overflow'] })]));
  assert.throws(() => actualValidateFindings({ findings: [], limitations: Array(51).fill('model') }, source()), /Invalid review response/);
});

test('source-derived envelope stages roundtrip IDs while fake precision windows and attribution remain rejected', () => {
  const before = Array.from({ length: 1200 }, (_, i) => 'old line ' + i + ' ' + 'a'.repeat(30) + '\n').join('');
  const file = { ...source(), left: { text: before }, right: { text: before.replaceAll('old line', 'new line') } };
  const s = { id: 'envelope', files: [file] }, changes = reviewChangeMap(file.left.text, file.right.text);
  assert.equal(changeMap(file.left.text, file.right.text).status, 'limited'); assert.equal(changes.precision, 'envelope');
  const windows = sourceSegments(changeWindows(file, changes)), window = windows[0];
  const raw = rawFinding(); raw.anchor = { kind: 'line', side: 'new', start: window.new.start, end: window.new.start, snippet: file.right.text.split('\n')[window.new.start - 1] };
  raw.attribution.editIds = ['envelope1'];
  const g = actualValidateFindings({ findings: [raw], limitations: [] }, file);
  const r = record({ windowIds: [window.id] }, g), [saved] = prepareStageGenerations(s, [r]);
  assert.deepEqual(saved.generation, g); assert.equal(saved.generation.findings[0].attribution.precision, 'envelope');
  assert.deepEqual(prepareStageGenerations(s, JSON.parse(JSON.stringify([saved]))), [saved]);
  for (const patch of [{ precision: 'exact' }, { notice: 'exact evidence' }, { causality: 'proven' }, { editIds: ['e1'] }]) {
    const bad = structuredClone(saved); delete bad.generation.findings[0].id; Object.assign(bad.generation.findings[0].attribution, patch); rejects(() => prepareStageGenerations(s, [bad]));
  }
  const fake = structuredClone(saved); fake.windowIds = ['envelope-h1-s99999']; fake.key = stageKey('f', fake); rejects(() => prepareStageGenerations(s, [fake]));
  const outside = structuredClone(saved), other = windows[1]; outside.generation.findings[0].anchor = { kind: 'line', side: 'new', start: other.new.start, end: other.new.start, snippet: file.right.text.split('\n')[other.new.start - 1] };
  delete outside.generation.findings[0].id; rejects(() => prepareStageGenerations(s, [outside]));
});

test('sparse arrays and accessor-hook mutations cannot bypass normalized output schema', () => {
  const sparse=record();sparse.generation.findings=Array(2);rejects(()=>prepare([sparse]));
  const [saved]=prepareStageGenerations(snapshot(),[record()],{validateGeneration(g,file,descriptor){g.findings[0].verification={receiptId:'STALE'};descriptor.generation.receipts=['STALE'];}});
  assert.doesNotMatch(JSON.stringify(saved),/verification|receipt|STALE/);
});
