import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewSnapshot } from '../src/review.mjs';
const snap={id:'staged-budget',root:'/repo',vcs:'git',context:[],files:[{id:'f',path:'a.js',eligibility:'reviewable',properties:[],left:{text:'guard();'},right:{text:'unsafe();'}}]};
const finding={fileId:'f',severity:'high',title:'Guard removed',evidence:'unsafe();',trigger:'invalid input',impact:'invalid operation',suggestion:'retain guard',anchor:{kind:'line',side:'new',start:1,end:1,snippet:'unsafe();'}};
async function run(options={}, requestedReads=4){
 let primary=0,verify=0;
 const report=await reviewSnapshot(snap,request=>{const input=JSON.parse(request.input);if(!input.candidates){primary++;return{findings:[finding],limitations:[]};}verify++;if(verify<=requestedReads)return{requests:[{kind:'read',id:input.catalog[0].id,start:1,count:1}]};return{verdicts:input.candidates.map(c=>({candidateId:c.candidateId,verdict:'uncertain',reason:'Need external contract',evidence:[]}))};},{enableRetrieval:true,enableVerification:true,...options});
 return{report,primary,verify};
}
test('staged primary default3 verification default6 can complete four supplemental turns',async()=>{
 const r=await run();assert.equal(r.primary,1);assert.equal(r.verify,5);assert.equal(r.report.findings[0].verification.status,'completed');assert.equal(r.report.readerLimits.maxRounds,3);assert.equal(r.report.readerLimits.maxVerificationRounds,6);
});
test('staged explicit verification3 still stops without silently borrowing primary rounds',async()=>{
 const r=await run({maxVerificationRetrievalRounds:3});assert.equal(r.verify,5);assert.equal(r.report.findings[0].verification.status,'completed');assert.equal(r.report.findings[0].verification.verdict,'uncertain');assert.equal(r.report.files[0].retrievalLimited,true);assert.ok(r.report.files[0].retrievalLimits.some(info=>info.code==='RETRIEVAL_ROUND_BUDGET_EXCEEDED'));assert.equal(r.report.status,'partial');
});
test('staged exact verification3 natural final is completed without a denied retrieval',async()=>{
 const r=await run({maxVerificationRetrievalRounds:3},3);assert.equal(r.verify,4);assert.equal(r.report.findings[0].verification.status,'completed');assert.equal(r.report.findings[0].verification.verdict,'uncertain');assert.notEqual(r.report.files[0].retrievalLimited,true);
});
test('staged primary0 defaults verification0 final-only and invalid override refuses before send',async()=>{
 const r=await run({maxRetrievalRounds:0});assert.equal(r.primary,1);assert.equal(r.report.readerLimits.maxVerificationRounds,0);assert.equal(r.report.findings[0].verification.status,'incomplete');
 let calls=0;await assert.rejects(reviewSnapshot(snap,()=>{calls++;},{maxVerificationRetrievalRounds:51}));assert.equal(calls,0);
});
