import test from 'node:test';
import assert from 'node:assert/strict';
import { modelComparisonValidated, comparisonValidated, reportSummaryData, reportSummaryMarkdown, verificationPresentation } from '../src/report-summary.mjs';
import { findingsMarkdown } from '../src/report-findings.mjs';
import { runCounterVerification } from '../src/counter-verification.mjs';
import { verificationLoop } from '../src/verification-loop.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { changeMap } from '../src/change-map.mjs';
function setup(){const files=[['oldEntry','old gate();',''],['oldDelegate','old delegate();',''],['primary','','new entry();'],['caller','invoke();','invoke();']].map(([id,left,right])=>({id,path:id+'.js',eligibility:'reviewable',properties:[],left:{text:left},right:{text:right}}));const snapshot={id:'presentation',vcs:'git',root:'/repo',context:[],files},scope=createRetrievalScope(snapshot);const candidate={fileId:'primary',path:'primary.js',severity:'high',title:'Gate changed',trigger:'Rejected request',impact:'State changes',suggestion:'Retain gate',anchor:{kind:'line',side:'new',start:1,end:1,snippet:'new entry();'},attribution:{status:'references-validated',editIds:changeMap('','new entry();').edits.map(e=>e.id)}};return{snapshot,scope,candidate,request:{input:JSON.stringify({snapshotId:snapshot.id}),instructions:'review'}};}
function model(seen=[],classification='introduced'){return request=>{const p=JSON.parse(request.input);seen.push(p);const sources=[['oldEntry','old'],['oldDelegate','old'],['primary','new'],['caller','old']].map(([fileId,side])=>p.catalog.find(s=>s.fileId===fileId&&s.side===side));const refs=sources.map(s=>p.retrieved.find(r=>r.result.sourceId===s.id)?.result);if(refs.some(r=>!r))return{requests:sources.filter((_,i)=>!refs[i]).map(s=>({kind:'read',id:s.id,start:1,count:1}))};return{verdicts:[{candidateId:'c1',verdict:'supported',reason:'Exact source comparison',evidence:refs.map(r=>({receiptId:r.receiptId})),regression:{classification,reason:'Same trigger',comparison:{kind:'model-assessed-cross-file',roles:{oldEntry:[0],oldDelegate:[1],newEntry:[2],callers:[3]},relationshipReason:'Old public gate versus new public entry'}}}]};};}
async function baseline(f){const seen=[];const result=(await verificationLoop(model(seen),f.request,[f.candidate],f.scope,{enableModelComparison:true,migrationSnapshot:f.snapshot,maxRounds:3}))[0];f.baselineReceiptIds=seen.flatMap(p=>p.retrieved??[]).map(r=>r.result.receiptId).filter(Boolean);return result;}

test('new comparison is separately disclosed without strict statistic promotion or source mutation',async()=>{
 const f=setup(),v=await baseline(f),finding={...f.candidate,verification:{status:'completed',...v}},report={findings:[finding]},before=structuredClone(report);
 assert.equal(modelComparisonValidated(finding),true);assert.equal(comparisonValidated(finding),false);assert.equal(verificationPresentation(finding),'uncertain');
 assert.equal(reportSummaryData(report).counts.introduced,0);assert.equal(reportSummaryData(report).counts.unresolved,1);assert.deepEqual(reportSummaryData(report).modelComparison,{supported:1,introduced:1,preexisting:0});
 const text=findingsMarkdown(report).join(String.fromCharCode(10));assert.match(text,/模型跨文件比较支持（关系由模型判断，未证明因果）/);assert.doesNotMatch(text,/### 本次新增（复核支持）/);assert.match(text,/不是宿主契约或因果证明/);
 assert.match(reportSummaryMarkdown(report).join(' '),/不计入上述严格新增／原有支持统计/);assert.deepEqual(report,before);
});

test('missing flags unsupported incomplete and inconsistent reference groups do not gain new support',async()=>{
 const f=setup(),v=await baseline(f);
 for(const mutate of [x=>delete x.verification.regression.sourceReferencesValidated,x=>x.verification.regression.relationshipStatus='host-proven',x=>x.verification.verdict='uncertain',x=>x.verification.status='incomplete',x=>x.verification.regression.newEvidence=[0],x=>x.verification.evidence[0].status='unvalidated',x=>x.verification.regression.comparison.roles.newEntry=[0]]){const x={...f.candidate,verification:{status:'completed',...structuredClone(v)}};mutate(x);assert.equal(modelComparisonValidated(x),false);assert.equal(reportSummaryData({findings:[x]}).modelComparison.supported,0);}
});

test('explicit counter accepts only matching new protocol and fresh independent evidence',async()=>{
 const f=setup(),v=await baseline(f),seen=[];const r=await runCounterVerification(model(seen),f.request,[f.candidate],[v],f.scope,{enabled:true,enableModelComparison:true,migrationSnapshot:f.snapshot,maxRounds:3});
 assert.equal(r[0].verdict,'supported');assert.equal(r[0].counterVerification.status,'completed');assert.equal(r[0].regression.status,'model-comparison-references-validated');
 assert.ok(seen.every(p=>p.candidates[0].finding.verification===undefined));
 const oldIds=new Set(f.baselineReceiptIds),freshIds=seen.flatMap(p=>p.retrieved??[]).map(row=>row.result.receiptId).filter(Boolean);assert.ok(oldIds.size>0);assert.ok(freshIds.length>0);assert.ok(freshIds.every(id=>!oldIds.has(id)));
 const disagreement=await runCounterVerification(model([],'preexisting'),f.request,[f.candidate],[v],f.scope,{enabled:true,enableModelComparison:true,migrationSnapshot:f.snapshot,maxRounds:3});assert.equal(disagreement[0].verdict,'uncertain');
 const disabled=await runCounterVerification(model(),f.request,[f.candidate],[v],f.scope,{enabled:true,enableModelComparison:false,migrationSnapshot:f.snapshot,maxRounds:3});assert.equal(disabled[0].verdict,'uncertain');
 const mixed=structuredClone(v);mixed.regression.status='comparison-references-validated';
 const mismatch=await runCounterVerification(model(),f.request,[f.candidate],[mixed],f.scope,{enabled:true,enableModelComparison:true,migrationSnapshot:f.snapshot,maxRounds:3});assert.equal(mismatch[0].verdict,'uncertain');
});
