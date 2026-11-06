import test from 'node:test';
import assert from 'node:assert/strict';
import { verificationRetrievalRounds } from '../src/review-execution-policy.mjs';
import { reviewWholeScope } from '../src/whole-scope-review.mjs';
import { validateFindings } from '../src/review.mjs';
const snapshot = { id:'verification-policy',vcs:'git',root:'/repo',context:[],files:[{id:'f',path:'a.js',eligibility:'reviewable',properties:[],left:{text:'guard();'},right:{text:'unsafe();\n'+'line();\n'.repeat(600)}}] };
const finding = {fileId:'f',severity:'medium',title:'Guard removed',evidence:'unsafe operation',trigger:'invalid state',impact:'failure',suggestion:'restore guard',anchor:{kind:'line',side:'new',start:1,end:1,snippet:'unsafe();'},attribution:{editIds:['e1'],properties:[],beforeBehavior:'guarded',afterBehavior:'unguarded',reason:'guard removed'}};
const base={nativeOutputTools:true,validateFindingResponse:validateFindings,maxRetrievalRounds:3};
const final=input=>({verdicts:input.candidates.map(c=>({candidateId:c.candidateId,verdict:'uncertain',reason:'External contract absent from approved scope',evidence:[]}))});
function model(requestsBeforeFinal, seen, malformed=false){let reads=0;return req=>{
  seen.push({phase:req.reviewPhase,final:!!JSON.parse(req.input).retrievalFinalization});
  if(req.reviewPhase==='group-primary')return{reviews:[{fileId:'f',findings:[finding],limitations:[]}],limitations:[]};
  const input=JSON.parse(req.input);
  if(!input.retrievalFinalization&&reads++<requestsBeforeFinal)return{requests:[{kind:'read',id:input.catalog.find(c=>c.side==='new').id,start:10+reads*2,count:1}]};
  if(malformed)return{verdicts:[{candidateId:'foreign',verdict:'uncertain',reason:'not valid',evidence:[]}]};
  return final(input);
};}
test('verification allowance defaults to six without changing primary three or granting unbounded rounds',()=>{
  assert.equal(verificationRetrievalRounds(undefined,3),6);assert.equal(verificationRetrievalRounds(undefined,7),7);
  assert.equal(verificationRetrievalRounds(undefined,0),0);assert.equal(verificationRetrievalRounds(0,3),0);assert.equal(verificationRetrievalRounds(3,3),3);
  for(const v of [-1,51,Infinity,1.5,'6',null])assert.throws(()=>verificationRetrievalRounds(v,3));
});
test('four required evidence turns can finish naturally under verification six, primary remains three',async()=>{
  const seen=[];const r=await reviewWholeScope(snapshot,model(4,seen),base);
  assert.equal(r.orchestration.maxRetrievalRounds,3);assert.equal(r.orchestration.maxVerificationRetrievalRounds,6);
  assert.equal(r.modelCalls,6);assert.equal(r.orchestration.verifications[0].status,'completed');
  assert.equal(r.findings[0].verification.verdict,'uncertain');assert.equal(r.findings[0].verification.status,'completed');
  assert.ok(seen.every(x=>!x.final));
});
test('explicit verification three retains genuine round limitation; valid final does not erase it',async()=>{
  const seen=[];const r=await reviewWholeScope(snapshot,model(4,seen),{...base,maxVerificationRetrievalRounds:3});
  assert.equal(r.orchestration.verifications[0].status,'pending');assert.equal(r.orchestration.verifications[0].retrievalLimited,true);
  assert.ok(seen.some(x=>x.phase==='verification'&&x.final));assert.equal(r.findings[0].verification.verdict,'uncertain');
});
test('shared model call cap remains unchanged despite extra verification allowance',async()=>{
  const seen=[];const r=await reviewWholeScope(snapshot,model(4,seen),{...base,maxCalls:2});
  assert.equal(r.modelCalls,2);assert.equal(seen.length,2);assert.equal(r.findings[0].verification.status,'incomplete');
});
test('explicit zero allows final only and primary zero propagates default verification zero',async()=>{
  for(const options of [{...base,maxVerificationRetrievalRounds:0},{...base,maxRetrievalRounds:0}]){
    const seen=[];const r=await reviewWholeScope(snapshot,model(0,seen),options);
    assert.equal(r.orchestration.maxVerificationRetrievalRounds,0);assert.ok(seen.some(x=>x.phase==='verification'&&x.final));
  }
});
test('invalid final candidate identity still fails strict verification instead of becoming uncertain',async()=>{
  const seen=[];const r=await reviewWholeScope(snapshot,model(0,seen,true),base);
  assert.equal(r.orchestration.verifications[0].status,'failed');assert.equal(r.findings[0].verification.status,'incomplete');
  assert.equal(r.findings[0].verification.verdict,undefined);
});
test('a valid verdict after exactly the permitted reads is not mislabeled as denied retrieval',async()=>{
 const seen=[];const r=await reviewWholeScope(snapshot,model(6,seen),base);
 assert.equal(r.orchestration.verifications[0].status,'completed');assert.notEqual(r.orchestration.verifications[0].retrievalLimited,true);
 assert.equal(r.findings[0].verification.status,'completed');assert.equal(r.findings[0].verification.verdict,'uncertain');
 assert.equal(r.modelCalls,8);assert.ok(seen.every(x=>!x.final));
});
