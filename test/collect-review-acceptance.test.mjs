import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { evaluateReviewAcceptance, collectReviewAcceptance } from '../scripts/collect-review-acceptance.mjs';
const expected = {sessionId:'s',cwd:'/fixed',provider:'p',model:'m',repositoryUuid:'uuid',url:'https://example.invalid/repo',baseRevision:'1',targetRevision:'2',eligibleCount:2,totalCount:3,expectedBlockedPaths:['directory']};
function fixture() {
 return {jobId:'j',owner:{sessionId:'s',cwd:'/fixed',provider:'p',model:'m'},status:'completed',checkpoints:[],result:{markdown:'BRIEF',technicalMarkdown:'TECHNICAL',report:{snapshotId:'snap',status:'partial',model:{provider:'p',model:'m'},history:{repositoryUuid:'uuid',url:expected.url,base:'1',target:'2'},files:[{fileId:'a',path:'a',status:'completed'},{fileId:'b',path:'b',status:'completed'},{fileId:'d',path:'directory',status:'blocked'}],findings:[],coverage:{total:3,completed:2,blocked:1,failed:0,pending:0},orchestration:{strategy:'whole-scope',batches:[{id:'batch',fileIds:['a','b'],status:'completed'}]},modelCalls:0,diagnostics:{retrievalInvalidReport:0,retrievalProtocolTelemetry:{scope:'all-child-tool-generations',complete:true,invalidRequests:0},executionWallMs:12}}}};
}
test('partial cross-batch report can pass single-run engineering, never quality',()=>{
 const j=fixture(),before=structuredClone(j),r=evaluateReviewAcceptance(j,expected);
 assert.equal(r.engineeringResult,'passed');assert.equal(r.overallReviewPassed,false);assert.equal(r.quality.precision,null);assert.equal(r.quality.truePositive,null);assert.deepEqual(j,before);
});
test('strict owner and historical identity mismatch fail, missing identity not inferred',()=>{
 for(const k of ['sessionId','cwd','provider','model']){const j=fixture();j.owner[k]='drift';assert.equal(evaluateReviewAcceptance(j,expected).engineeringResult,'failed');}
 for(const mutate of [j=>delete j.result.report.model,j=>j.result.report.history.repositoryUuid='other',j=>j.result.report.history.url+='x',j=>j.result.report.history.base='0',j=>j.result.report.history.target='3']){const j=fixture();mutate(j);assert.ok(evaluateReviewAcceptance(j,expected).issues.some(i=>i.code==='REPORT_IDENTITY_MISMATCH'));}
});
test('all members and recomputed coverage must match without dropping failed denominator',()=>{
 for(const mutate of [j=>j.result.report.files.pop(),j=>j.result.report.files.push({...j.result.report.files[0]}),j=>j.result.report.coverage.completed=3,j=>j.result.report.coverage={},j=>j.result.report.orchestration.batches[0].status='pending',j=>j.result.report.orchestration.batches[0].fileIds=['a','a'],j=>j.result.report.orchestration.batches[0].fileIds=['a','unexpected'],j=>j.result.report.totalFiles=20,j=>j.result.report.files[2].path='new-block']){const j=fixture();mutate(j);assert.equal(evaluateReviewAcceptance(j,expected).engineeringResult,'failed');}
});
test('typed failure and capacity cause engineering failure regardless completed driver',()=>{
 const j=fixture();Object.assign(j.result.report.files[0],{status:'failed',failureCode:'WHOLE_SCOPE_INPUT_BUDGET'});Object.assign(j.result.report.coverage,{completed:1,failed:1});Object.assign(j.result.report.orchestration.batches[0],{status:'failed',failureCode:'WHOLE_SCOPE_INPUT_BUDGET',requiredBytes:542190,approvedCap:524288});
 const r=evaluateReviewAcceptance(j,expected);assert.equal(r.engineeringResult,'failed');assert.equal(r.fileFailureCodes.WHOLE_SCOPE_INPUT_BUDGET,1);assert.ok(r.issues.some(i=>i.code==='TYPED_INPUT_CAPACITY_EXCEEDED'));assert.equal(r.eligible.unfinished,1);
});
test('pending eligible and retrieval-limited stage never pass',()=>{
 const j=fixture();j.result.report.files[0].status='pending';Object.assign(j.result.report.coverage,{completed:1,pending:1});j.result.report.orchestration.batches[0].retrievalLimited=true;
 const r=evaluateReviewAcceptance(j,expected);assert.equal(r.engineeringResult,'failed');assert.ok(r.issues.some(i=>i.code==='RETRIEVAL_LIMITED'));
});
test('retrieval missing telemetry remains unknown; prose never defines status',()=>{
 const j=fixture();delete j.result.report.diagnostics.retrievalInvalidReport;delete j.result.report.diagnostics.retrievalProtocolTelemetry;j.result.report.limitations=[{text:'Unsupported retrieval operation WHOLE_SCOPE_INPUT_BUDGET'}];
 const r=evaluateReviewAcceptance(j,expected);assert.equal(r.retrievalInvalidReport,'unknown');assert.equal(r.engineeringResult,'incomplete');assert.equal(r.issues.length,0);
 j.result.report.diagnostics.retrievalInvalidReport=0;assert.equal(evaluateReviewAcceptance(j,expected).engineeringResult,'incomplete');
 j.result.report.diagnostics.retrievalProtocolTelemetry={scope:'host-child-snapshot-request-parser',complete:true,invalidRequests:0};assert.equal(evaluateReviewAcceptance(j,expected).engineeringResult,'incomplete');
 j.result.report.diagnostics.retrievalProtocolTelemetry={scope:'all-child-tool-generations',complete:true,invalidRequests:0};assert.equal(evaluateReviewAcceptance(j,expected).engineeringResult,'passed');
 j.result.report.limitations.push({code:'RETRIEVAL_PROTOCOL_ERROR'});assert.equal(evaluateReviewAcceptance(j,expected).retrievalInvalidReport,'invalid');
});
test('typed malformed counts and report states reject rather than coerce',()=>{
 for(const mutate of [j=>j.result.report.diagnostics.retrievalInvalidReport='0',j=>j.result.report.modelCalls=-1,j=>j.result.report.coverage.pending='0',j=>j.result.report.status='clean',j=>j.result.report.outdated='false',j=>j.result.report.orchestration.batches[0].requiredBytes='large']){const j=fixture();mutate(j);assert.equal(evaluateReviewAcceptance(j,expected).engineeringResult,'failed');}
 assert.throws(()=>evaluateReviewAcceptance(fixture(),{...expected,totalCount:4}));
});
test('nonterminal, failed job and unavailable report are not a product pass',()=>{
 const j=fixture();j.status='running';assert.equal(evaluateReviewAcceptance(j,expected).engineeringResult,'incomplete');j.status='failed';assert.equal(evaluateReviewAcceptance(j,expected).engineeringResult,'failed');delete j.result;assert.equal(evaluateReviewAcceptance(j,expected).engineeringResult,'failed');
});
test('children started include failed children; unmatched call accounting remains explicit',()=>{
 const j=fixture();j.result.report.orchestration.childrenStarted=[{childId:'c1'},{childId:'c2'}];j.checkpoints=[{stage:'host-child-complete',childId:'c1',modelCalls:3},{stage:'model-end'}];j.result.report.modelCalls=7;
 const r=evaluateReviewAcceptance(j,expected);assert.equal(r.operations.childrenStarted,2);assert.equal(r.operations.completionReceiptCallDifference,3);assert.equal(r.operations.reportedModelCalls,7);
});
test('collector preserves exact input and existing result text, refuses overwrite',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'acceptance-'));
 try {const jobFile=path.join(dir,'official.json'),outputDir=path.join(dir,'out');const raw=JSON.stringify(fixture());await writeFile(jobFile,raw);const result=await collectReviewAcceptance({jobFile,outputDir,expected});assert.equal(result.engineeringResult,'passed');assert.equal(await readFile(path.join(outputDir,'full-public-result.json'),'utf8'),raw);assert.equal(await readFile(jobFile,'utf8'),raw);assert.equal(await readFile(path.join(outputDir,'brief.md'),'utf8'),'BRIEF');assert.equal(await readFile(path.join(outputDir,'technical.md'),'utf8'),'TECHNICAL');assert.match(await readFile(path.join(outputDir,'engineering-summary.md'),'utf8'),/Quality unknown/);await assert.rejects(collectReviewAcceptance({jobFile,outputDir,expected}));}
 finally {await rm(dir,{recursive:true,force:true});}
});
function recoveryFixture(status='capacity-superseded') {
 const j=fixture();j.result.report.orchestration.batches=[
 {id:'parent',fileIds:['a','b'],status,childBatchIds:['left','right'],retrievalLimited:true,retrievalLimits:[{code:status==='capacity-superseded'?'CHILD_FOLLOWUP_CAPACITY':'WHOLE_SCOPE_INPUT_BUDGET'}],retrievalAudit:[{kind:'read',sourceId:'source'}],...(status==='split-before-send'?{failureCode:'WHOLE_SCOPE_INPUT_BUDGET',requiredBytes:100,approvedCap:90}:{})},
 {id:'left',parentBatchId:'parent',fileIds:['a'],status:'completed'},
 {id:'right',parentBatchId:'parent',fileIds:['b'],status:'completed'}];return j;
}
test('exact capacity tree retires only historical capacity after all leaves complete',()=>{
 for(const status of ['capacity-superseded','split-before-send']){const j=recoveryFixture(status),before=structuredClone(j),r=evaluateReviewAcceptance(j,expected);assert.equal(r.engineeringResult,'passed',JSON.stringify(r.issues));assert.equal(r.capacityRecovery.recoveredParentCount,1);assert.equal(r.capacityRecovery.currentLeafCount,2);assert.equal(r.capacityRecovery.parents[0].retrievalAudit.length,1);assert.deepEqual(j,before);}
});
test('malformed recovery graphs cannot erase parent pending or failed coverage',()=>{
 const mutations=[b=>b[0].childBatchIds=['left'],b=>b[0].childBatchIds=['left','missing'],b=>b[1].parentBatchId='missing',b=>b[2].fileIds=['a'],b=>b[2].fileIds=['b','foreign'],b=>b.push({...b[1]}),b=>b[2].parentBatchId='left',b=>b[0].parentBatchId='right',b=>b[2].status='pending',b=>b[2].status='failed',b=>delete b[0].childBatchIds,b=>b.push({id:'orphan',parentBatchId:'parent',fileIds:['a'],status:'completed'}),b=>b[0].childBatchIds=['parent','right']];
 for(const mutate of mutations){const j=recoveryFixture();mutate(j.result.report.orchestration.batches);assert.equal(evaluateReviewAcceptance(j,expected).engineeringResult,'failed');}
});
test('unrelated historical errors and current limitations are not capacity recovery',()=>{
 for(const mutate of [j=>j.result.report.orchestration.batches[0].failureCode='RETRIEVAL_PROTOCOL_ERROR',j=>j.result.report.orchestration.batches[0].retrievalLimits.push({code:'RETRIEVAL_ROUND_BUDGET_EXCEEDED'}),j=>j.result.report.files[0].retrievalLimited=true,j=>j.result.report.orchestration.batches[1].failureCode='OTHER_FAILURE',j=>j.result.report.findings=[{fileId:'a',verification:{status:'incomplete'}}]]){const j=recoveryFixture();mutate(j);assert.equal(evaluateReviewAcceptance(j,expected).engineeringResult,'failed');}
 const j=recoveryFixture();delete j.result.report.diagnostics.retrievalProtocolTelemetry;assert.equal(evaluateReviewAcceptance(j,expected).engineeringResult,'incomplete');
});
test('nested completed recovery validates exact original and terminal membership',()=>{
 const j=recoveryFixture();const b=j.result.report.orchestration.batches;b[0].fileIds.push('c');b[2].fileIds.push('c');b[2].status='capacity-superseded';b[2].childBatchIds=['r1','r2'];b[2].retrievalLimited=true;b[2].retrievalLimits=[{code:'CHILD_FOLLOWUP_CAPACITY'}];b.push({id:'r1',parentBatchId:'right',fileIds:['b'],status:'completed'},{id:'r2',parentBatchId:'right',fileIds:['c'],status:'completed'});j.result.report.files.push({fileId:'c',path:'c',status:'completed'});Object.assign(j.result.report.coverage,{total:4,completed:3});const e={...expected,eligibleCount:3,totalCount:4};assert.equal(evaluateReviewAcceptance(j,e).engineeringResult,'passed');b[4].fileIds=['foreign'];assert.equal(evaluateReviewAcceptance(j,e).engineeringResult,'failed');
});
test('collector refuses exact artifacts path without reading its contents',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'acceptance-'));
 try{await mkdir(path.join(dir,'artifacts'));const jobFile=path.join(dir,'artifacts','private.json');await writeFile(jobFile,'NOT PUBLIC');await assert.rejects(collectReviewAcceptance({jobFile,outputDir:path.join(dir,'out'),expected}),/artifacts path/);}
 finally {await rm(dir,{recursive:true,force:true});}
});
