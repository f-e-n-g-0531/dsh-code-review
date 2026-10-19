import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewSnapshot, validateFindings } from '../src/review.mjs';
import { correctAnchor } from '../src/anchor-correction.mjs';
import { correctedResponse } from '../src/response-correction.mjs';
import { modelContract } from '../src/model-contract.mjs';
const file = () => ({id:'f',path:'a.js',reviewMode:'project',eligibility:'reviewable',properties:[],left:{text:''},right:{text:'keep\nunsafe();\nend'}});
const snapshot = () => ({id:'s',vcs:'git',projectScope:{mode:'project'},files:[file()]});
const finding = () => ({fileId:'f',severity:'high',title:'defect',evidence:'unsafe',trigger:'input',impact:'failure',suggestion:'check',anchor:{kind:'line',side:'new',start:2,end:2,snippet:'unsafe();'}});
const response = value => ({findings:[value],limitations:[]});

test('schema correction snapshots approved request before async hooks can mutate it',async()=>{
 const req={instructions:'review',input:'approved'};let calls=0;
 const output=await correctedResponse(async r=>{calls++;assert.equal(r.input,'approved');return calls;},value=>{if(value===1)throw Object.assign(new Error('bad'),{code:'MODEL_INVALID_FINDING_IDENTITY'});return value;},req,{enabled:true,onCorrection:()=>{req.input='unapproved';req.instructions='changed';}});
 assert.equal(output,2);assert.equal(calls,2);
});
test('all finalization stage contracts prohibit more retrieval without losing their schema',()=>{
 for(const payload of [{file:{}},{candidates:[]},{sourceMode:'file-interaction'}]){const contract=modelContract(JSON.stringify({...payload,retrievalFinalization:{code:'READER_CALL_BUDGET_EXCEEDED'}}));assert.match(contract,/禁止requests/);assert.match(contract,/findings|verdicts/);}
});

for (const keepFinding of [false, true]) test('reader exhaustion is pending, never clean; preserves candidates='+keepFinding,async()=>{
 let calls=0;const events=[];
 const result=await reviewSnapshot(snapshot(),async req=>{
  calls++;const p=JSON.parse(req.input);
  assert.ok(p.retrievalBudget);
  if(p.retrievalFinalization){assert.match(req.instructions,/不得再返回requests/);return {findings:keepFinding?[finding()]:[],limitations:[]};}
  return {requests:Array.from({length:8},()=>({kind:'find',query:'a.js',limit:1}))};
 },{correctProtocol:true,enableRetrieval:true,maxCalls:12,onProgress:e=>events.push(e)});
 assert.ok(events.some(e=>e.action==='retrieval-budget-finalization'));
 assert.ok(calls<=8);assert.equal(result.coverage.completed,0);assert.equal(result.coverage.pending,1);assert.equal(result.status,'partial');assert.equal(result.findings.length,keepFinding?1:0);assert.equal(result.files[0].retrievalLimited,true);assert.ok(result.retrievalUsage.calls<=50);assert.match(result.files[0].reason,/不表示通过/);
});

test('invalid final-only schema cannot restart retrieval through primary response correction',async()=>{
 const s=snapshot();s.context=[{path:'large.js',text:'x'.repeat(65537)+'\nok();'}];let calls=0;
 const r=await reviewSnapshot(s,async req=>{calls++;const p=JSON.parse(req.input);if(calls===1){const source=p.catalog.find(c=>c.path==='large.js');assert.ok(source);return {requests:[{kind:'read',id:source.id,start:1,count:1}]};}assert.ok(p.retrievalFinalization);assert.equal(calls,2);return response({...finding(),fileId:'wrong'});},{correctProtocol:true,enableRetrieval:true,maxCalls:5});
 assert.equal(calls,2);assert.equal(r.retrievalUsage.calls,0);assert.equal(r.files[0].retrievalLimited,true);assert.equal(r.coverage.completed,0);assert.equal(r.files[0].failureCode,'MODEL_INVALID_FINDING_IDENTITY');assert.equal(r.files[0].responseCorrections,undefined);
});

for (const [name, mutate, code] of [
 ['identity',f=>{f.fileId='a.js';},'MODEL_INVALID_FINDING_IDENTITY'],
 ['severity',f=>{f.severity='P1';},'MODEL_INVALID_FINDING_SEVERITY'],
 ['snippet',f=>{f.anchor.snippet='invented';},'MODEL_ANCHOR_MISMATCH'],
 ['field',f=>{delete f.trigger;},'MODEL_MISSING_FINDING_FIELD'],
 ['anchor',f=>{f.anchor.start=0;},'MODEL_INVALID_ANCHOR'],
]) {
 test('explicit response correction recovers '+name+' without local normalization',async()=>{
  let calls=0;const events=[];const bad=finding();mutate(bad);const original=structuredClone(bad);
  assert.throws(()=>validateFindings(response(bad),file()),e=>e.code===code);
  const result=await reviewSnapshot(snapshot(),async req=>{calls++;if(calls===1)return response(bad);assert.match(req.instructions,/明确的主审响应协议纠正/);assert.ok(!req.instructions.includes('invented'));return response(finding());},{correctProtocol:true,enableRetrieval:true,onProgress:e=>events.push(e)});
  assert.equal(calls,2);assert.equal(result.modelCalls,2);assert.equal(result.coverage.completed,1);assert.equal(result.findings.length,1);assert.equal(result.findings[0].fileId,'f');assert.deepEqual(bad,original);assert.equal(result.files[0].responseCorrections[0].code,code);assert.ok(events.some(e=>e.action==='review-response-correction'));assert.equal(result.status,'partial');
 });
}
test('one failed schema correction stays failed and retains redacted attempt codes',async()=>{let calls=0;const bad={...finding(),severity:'P1'};const r=await reviewSnapshot(snapshot(),async()=>{calls++;return response(bad);},{correctProtocol:true});assert.equal(calls,2);assert.equal(r.coverage.failed,1);assert.equal(r.findings.length,0);assert.equal(r.files[0].failureCode,'MODEL_INVALID_FINDING_SEVERITY');assert.equal(r.files[0].responseAttempts.length,2);});
test('schema correction respects shared call limit and disabled mode',async()=>{for(const options of [{correctProtocol:true,maxCalls:1},{}]){let calls=0;const r=await reviewSnapshot(snapshot(),async()=>{calls++;return response({...finding(),fileId:'other'});},options);assert.equal(calls,1);assert.equal(r.coverage.failed,1);assert.equal(r.findings.length,0);}});
test('response size and invalid project source side do not get relaxed or retried',async()=>{for(const value of ['x'.repeat(128*1024+1),response({...finding(),anchor:{kind:'line',side:'old',start:1,end:1,snippet:'keep'}})]){let calls=0;const r=await reviewSnapshot(snapshot(),async()=>{calls++;return value;},{correctProtocol:true});assert.equal(calls,1);assert.equal(r.coverage.failed,1);}});
test('cancellation before schema correction sends no extra request',async()=>{const controller=new AbortController();let calls=0;const r=await reviewSnapshot(snapshot(),async()=>{calls++;controller.abort(new Error('stop'));return response({...finding(),severity:'P1'});},{correctProtocol:true,signal:controller.signal});assert.equal(calls,1);assert.equal(r.coverage.cancelled,1);});
test('project exact anchor relocation needs no fabricated edit and remains same-source only',async()=>{const bad=finding();bad.anchor.start=1;bad.anchor.end=1;const f=file();const correction=correctAnchor(bad,f);assert.equal(correction.status,'corrected');assert.equal(correction.reason,'unique-exact-current-source');assert.equal(correction.candidate.anchor.start,2);assert.equal(bad.anchor.start,1);let calls=0;const r=await reviewSnapshot(snapshot(),async()=>{calls++;return response(bad);},{enableAnchorCorrection:true,correctProtocol:true});assert.equal(calls,1);assert.equal(r.findings[0].anchor.start,2);assert.deepEqual(r.files[0].anchorCorrections[0].originalCandidate,bad);for(const patch of [{fileId:'other'},{anchor:{...bad.anchor,snippet:'fake'}},{anchor:{...bad.anchor,side:'old'}}])assert.notEqual(correctAnchor({...bad,...patch},f).status,'corrected');assert.equal(correctAnchor(bad,{...f,right:{text:'keep\nunsafe();\nunsafe();'}}).reason,'ambiguous-exact-text');});
