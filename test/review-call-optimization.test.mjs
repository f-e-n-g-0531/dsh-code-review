import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewSnapshot} from '../src/review.mjs';
import {createReviewService} from '../src/service.mjs';
import {INLINE_RISK_INSTRUCTIONS} from '../src/prompts.mjs';

const empty=()=>({findings:[],limitations:[]});
const options={enableRetrieval:true,enableRiskPlanning:true,skipSmallRiskPlans:false,riskPlanningMode:'auto',optimizeReviewCalls:true,enablePrimarySeeds:true};
function snapshot(count=1){return {id:'optimized',vcs:'git',root:'/repo',context:[],files:Array.from({length:count},(_,i)=>({id:'f'+i,path:'unit'+i+'.js',eligibility:'reviewable',properties:[],left:{text:'guard();\n'},right:{text:'unsafe();\n'},rightExists:true}))};}
const candidate=id=>({fileId:id,severity:'high',title:'Guard removed',evidence:'unsafe path',trigger:'unguarded invocation',impact:'invalid state',suggestion:'restore guard',anchor:{kind:'line',side:'new',start:1,end:1,snippet:'unsafe();'}});
const risk=p=>({id:'r1',fileIds:[p.file.id],editRefs:[{fileId:p.file.id,editId:p.changes.edits[0].id}],question:'Is the removed guard necessary?',trigger:'invalid input',impact:'invalid state',checks:['Compare guard'],sourceIds:[]});
function fake({findings=false,risks='valid',seen=[]}={}){return request=>{const p=JSON.parse(request.input);seen.push({request,p});if(request.reviewPhase==='risk-planning')return {risks:[risk(p)]};if(request.reviewPhase==='verification'){assert.ok(!request.instructions.includes(INLINE_RISK_INSTRUCTIONS));const item=p.retrieved[0];assert.ok(item,'independent verifier must receive fresh host evidence');return {verdicts:p.candidates.map(c=>({candidateId:c.candidateId,verdict:'refuted',reason:'Synthetic counterevidence',evidence:[{receiptId:item.result.receiptId}]}))};}return {findings:findings?[candidate(p.file.id)]:[],limitations:[],...(risks==='missing'?{}:{risks:risks==='valid'?[risk(p)]:[{bad:true}]})};};}

test('eight full-body files use eight inline main calls instead of sixteen separate calls',async()=>{
 const input=snapshot(8),inlineSeen=[],separateSeen=[];
 const inline=await reviewSnapshot(input,fake({seen:inlineSeen}),options);
 const separate=await reviewSnapshot(input,fake({seen:separateSeen}),{...options,riskPlanningMode:'separate'});
 assert.equal(inline.modelCalls,8);assert.equal(separate.modelCalls,16);assert.deepEqual(inline.findings,separate.findings);assert.deepEqual(inline.coverage,separate.coverage);
 assert.equal(inlineSeen.filter(x=>x.request.reviewPhase==='risk-planning').length,0);assert.equal(separateSeen.filter(x=>x.request.reviewPhase==='risk-planning').length,8);
 assert.ok(inline.files.every(f=>f.riskPlans[0].method==='inline'&&f.riskPlans[0].status==='completed'));assert.equal(inline.coverage.completed,8);
});

test('inline retains identical validated findings and separate independent verifier verdicts',async()=>{
 const seen=[],legacySeen=[];
 const inline=await reviewSnapshot(snapshot(),fake({findings:true,seen}),{...options,enableVerification:true});
 const separate=await reviewSnapshot(snapshot(),fake({findings:true,seen:legacySeen}),{...options,riskPlanningMode:'separate',enableVerification:true});
 assert.deepEqual(inline.findings,separate.findings);assert.equal(inline.findings.length,1);assert.equal(inline.findings[0].verification.status,'completed');assert.equal(inline.findings[0].verification.verdict,'refuted');
 assert.equal(inline.modelCalls,2);assert.equal(separate.modelCalls,3);assert.deepEqual(seen.map(x=>x.request.reviewPhase),['primary','verification']);assert.equal(seen[1].p.retrieved[0].result.text,'unsafe();\n');
});

for(const [mode,status] of [['missing','absent'],['invalid','invalid']])test('optional '+mode+' inline risks preserve findings without extra planning or response correction',async()=>{
 const seen=[];const report=await reviewSnapshot(snapshot(),fake({findings:true,risks:mode,seen}),{...options,correctProtocol:true});
 assert.equal(report.modelCalls,1);assert.equal(report.findings.length,1);assert.equal(report.files[0].riskPlans[0].status,status);assert.equal(report.files[0].riskPlans[0].method,'inline');assert.equal(report.files[0].responseCorrections,undefined);assert.equal(report.files[0].status,'completed');assert.equal(report.status,'partial');assert.equal(seen.length,1);
});

test('two review rounds inline only first primary and never inline verifier instructions',async()=>{
 const seen=[];const report=await reviewSnapshot(snapshot(),fake({findings:true,seen}),{...options,reviewRounds:2,enableVerification:true});
 assert.equal(report.modelCalls,4);assert.deepEqual(seen.map(x=>x.request.reviewPhase),['primary','verification','primary','verification']);
 assert.ok(seen[0].request.instructions.includes(INLINE_RISK_INSTRUCTIONS));assert.ok(!seen[2].request.instructions.includes(INLINE_RISK_INSTRUCTIONS));
 assert.equal(report.files[0].riskPlans.length,1);assert.ok(report.files[0].reviewPasses.every(p=>p.status==='completed'));assert.equal(report.findings.length,2);
 const receipts=seen.filter(x=>x.request.reviewPhase==='verification').map(x=>x.p.retrieved[0].result.receiptId);assert.notEqual(receipts[0],receipts[1]);
});

test('maxRetrievalRounds zero spends no primary or verifier seed reader budget',async()=>{
 const seen=[];const report=await reviewSnapshot(snapshot(),request=>{const p=JSON.parse(request.input);seen.push({request,p});assert.deepEqual(p.retrieved,[]);return request.reviewPhase==='verification'?{verdicts:[{candidateId:'c1',verdict:'uncertain',reason:'No evidence retrieval authorized',evidence:[]}]}:{findings:[candidate(p.file.id)],limitations:[],risks:[]};},{...options,maxRetrievalRounds:0,enableVerification:true});
 assert.equal(report.modelCalls,2);assert.equal(report.retrievalUsage.calls,0);assert.equal(report.files[0].retrievalAudit,undefined);assert.equal(report.findings[0].verification.verdict,'uncertain');assert.equal(seen.length,2);
});

function windowed(){const input=snapshot();const lines=['import { Foo } from "./dep.js";','Foo();',...Array.from({length:100},()=> 'filler'.repeat(30))];const right=[...lines];right[60]='new value';input.files[0]={...input.files[0],path:'main.js',left:{text:lines.join('\n')},right:{text:right.join('\n')}};input.context=[{path:'dep.js',text:'\n'.repeat(49)+'export function Foo() {}\n'+'filler\n'.repeat(1000)}];return input;}

test('actual compact primary host seed avoids a discovery turn and provides exact approved context',async()=>{
 async function run(enablePrimarySeeds){const seen=[];const report=await reviewSnapshot(windowed(),request=>{const p=JSON.parse(request.input);seen.push({request,p});assert.equal(p.sourceMode,'change-windows');assert.deepEqual(p.context,[]);const source=p.catalog.find(s=>s.path==='dep.js');if(!p.retrieved.length)return {requests:[{kind:'read',id:source.id,start:46,count:40}]};const item=p.retrieved[0];assert.equal(item.result.sourceId,source.id);assert.equal(item.result.start,46);assert.equal(item.result.text,'\n'.repeat(4)+'export function Foo() {}\n'+'filler\n'.repeat(35));return empty();},{...options,enableRiskPlanning:false,maxInputBytes:14000,enablePrimarySeeds});return {report,seen};}
 const seeded=await run(true),unseeded=await run(false);assert.equal(seeded.report.files[0].contextMode,'approved-retrieval');assert.equal(seeded.report.modelCalls,1);assert.equal(unseeded.report.modelCalls,2);assert.deepEqual(seeded.report.findings,unseeded.report.findings);assert.equal(seeded.report.retrievalUsage.calls,1);assert.equal(seeded.report.files[0].retrievalAudit.length,1);assert.equal(seeded.report.files[0].retrievalAudit[0].stage,'retrieved-locally');
});

test('configured service preview and actual execution share scaled reader limits and inline call plan',async()=>{
 const source=snapshot(18);let calls=0;const service=createReviewService({async *stream(r){calls++;assert.deepEqual(r.tools,[]);const p=JSON.parse(r.messages[0].content[0].text);assert.ok(p.file);yield {type:'text-delta',text:JSON.stringify({findings:[],limitations:[],risks:[]})};yield {type:'finish',reason:{kind:'stop'}};}},{capture:async()=>source,allowModelSending:true,authorize:async()=>true,...options,readerBudgetPolicy:'scaled',changesConcurrency:1});
 const exec={agent:{session:{header:{cwd:'/repo'}},options:{provider:'fake',model:'offline'}},signal:new AbortController().signal};const preview=await service.preview({},exec);assert.equal(calls,0);assert.equal(preview.plan.minimumCalls,18);assert.deepEqual(preview.execution.readerBudget,{policy:'scaled',maxCalls:72,maxOutputBytes:18*16*1024});
 const {report}=await service.execute({previewId:preview.previewId,confirmed:true},exec);assert.equal(calls,18);assert.equal(report.modelCalls,preview.plan.minimumCalls);assert.equal(report.readerBudget.maxCalls,preview.execution.readerBudget.maxCalls);assert.equal(report.readerBudget.maxOutputBytes,preview.execution.readerBudget.maxOutputBytes);assert.equal(report.readerBudget.calls,0);assert.equal(report.coverage.completed,18);
});

for(const tailRequests of [false,true])test('duplicate batches materialize once while later hidden context and tail keep reader capacity; tail requests='+tailRequests,async()=>{
 const input=snapshot(7),large=windowed().files[0];large.id='window';large.path='main.js';input.files.push(large,{...snapshot().files[0],id:'tail',path:'tail.js'});input.context=windowed().context;
 const seen=[];const report=await reviewSnapshot(input,request=>{
  const p=JSON.parse(request.input);seen.push({request,p});
  if(p.file.id==='window'){
   assert.equal(p.contextMode,'approved-retrieval');
   if(!p.retrieved.length){assert.ok(p.retrievalBudget.remainingCalls>0);return {requests:[{kind:'read',id:p.catalog.find(s=>s.path==='dep.js').id,start:46,count:40}]};}
   const result=p.retrieved[0].result;assert.equal(result.start,46);assert.equal(result.count,40);assert.equal(result.text,input.context[0].text.split('\n').slice(45,85).join('\n')+'\n');
   return empty();
  }
  if(p.file.id==='tail'){
   assert.equal(p.contextMode,undefined);assert.equal(p.file.right.text,'unsafe();\n');
   if(tailRequests&&!p.retrieved.length){assert.ok(p.retrievalBudget.remainingCalls>0);return {requests:[{kind:'read',id:p.catalog.find(s=>s.fileId==='tail'&&s.side==='new').id,start:1,count:1}]};}
   if(tailRequests)assert.equal(p.retrieved[0].result.text,'unsafe();\n');
   return empty();
  }
  if(p.retrieved.length||p.retrievalFinalization)return empty();
  const index=Number(p.file.id.slice(1)),count=index<6?8:2;
  return {requests:Array.from({length:count},()=>({kind:'read',id:p.catalog.find(s=>s.fileId===p.file.id&&s.side==='new').id,start:1,count:1}))};
 },{...options,enableRiskPlanning:false,enablePrimarySeeds:false,maxInputBytes:18000,maxRetrievalRounds:2});
 const calls=8+Number(tailRequests);
 assert.equal(report.retrievalUsage.calls,calls);assert.equal(report.retrievalUsage.cacheHits,43);assert.equal(report.retrievalUsage.deliveries,51+Number(tailRequests));
 assert.equal(report.readerBudget.maxCalls,50);assert.equal(report.readerBudget.remainingCalls,50-calls);assert.equal(report.readerBudget.maxOutputBytes,256*1024);
 for(let i=0;i<7;i++){
  const turns=seen.filter(x=>x.p.file.id==='f'+i);assert.equal(turns.length,2);
  const first=turns[0].p,last=turns[1].p,count=i<6?8:2;
  assert.equal(last.retrieved.length,count);assert.equal(first.retrievalBudget.remainingCalls-last.retrievalBudget.remainingCalls,1,'duplicate batch consumes one materialization');
  assert.equal(first.retrievalBudget.remainingOutputBytes-last.retrievalBudget.remainingOutputBytes,last.retrieved.reduce((n,item)=>n+Buffer.byteLength(JSON.stringify(item.result)),0),'every duplicate delivery is still charged');
 }
 const hidden=report.files.find(f=>f.fileId==='window'),tail=report.files.find(f=>f.fileId==='tail');
 assert.equal(hidden.contextMode,'approved-retrieval');assert.equal(hidden.status,'completed');assert.equal(hidden.failureCode,undefined);assert.equal(hidden.windowCoverage.completed.length,1);assert.deepEqual(hidden.windowCoverage.pending,[]);
 assert.equal(tail.status,'completed');assert.equal(seen.filter(x=>x.p.file.id==='tail').length,tailRequests?2:1);assert.equal(seen.filter(x=>x.p.file.id==='window').length,2);
 assert.equal(hidden.retrievalAudit.length,1);assert.equal(hidden.retrievalAudit[0].start,46);assert.equal(hidden.retrievalAudit[0].stage,'retrieved-locally');
 assert.ok(!report.limitations.some(l=>l.text.includes('Reader call budget exceeded')));
});

test('fifty duplicate primary reads do not starve a grouped interaction that obtains its own fresh source',async()=>{
 const input=snapshot(2);input.files[0].path='src/a.js';input.files[1].path='test/a.test.js';
 const seen=[];let requested=0;
 const report=await reviewSnapshot(input,request=>{
  const p=JSON.parse(request.input);seen.push({request,p});
  if(request.reviewPhase==='risk-planning')return {risks:[]};
  if(p.sourceMode==='file-interaction'){
   if(!p.retrieved.length){assert.ok(p.retrievalBudget.remainingCalls>0);return {requests:[{kind:'read',id:p.catalog.find(s=>s.fileId==='f1'&&s.side==='new').id,start:1,count:1}]};}
   assert.equal(p.retrieved.length,1);assert.equal(p.retrieved[0].result.sourceId,p.catalog.find(s=>s.fileId==='f1'&&s.side==='new').id);assert.equal(p.retrieved[0].result.text,'unsafe();\n');
   return {...empty(),risks:[]};
  }
  if(p.file.id==='f1')return {...empty(),risks:[]};
  if(requested===50||p.retrievalFinalization)return {...empty(),risks:[]};
  const count=Math.min(8,50-requested);requested+=count;
  return {requests:Array.from({length:count},()=>({kind:'read',id:p.catalog.find(s=>s.fileId==='f0'&&s.side==='new').id,start:1,count:1}))};
 },{...options,enableGrouping:true,enablePrimarySeeds:false,maxRetrievalRounds:10});
 assert.equal(requested,50);assert.equal(report.grouping.groups.length,1);assert.deepEqual(report.grouping.groups[0].fileIds,['f0','f1']);
 assert.equal(report.retrievalUsage.calls,2);assert.equal(report.retrievalUsage.cacheHits,49);assert.equal(report.retrievalUsage.deliveries,51);assert.equal(report.readerBudget.maxCalls,50);assert.equal(report.readerBudget.remainingCalls,48);
 assert.equal(report.files[0].retrievalAudit.length,50);assert.equal(report.files[1].status,'completed');assert.equal(seen.filter(x=>x.p.file?.id==='f1').length,1);
 assert.equal(report.interactions.length,1);assert.equal(report.interactions[0].status,'completed');assert.equal(report.interactions[0].failureCode,undefined);
 const interaction=seen.filter(x=>x.p.sourceMode==='file-interaction'&&x.request.reviewPhase!=='risk-planning');assert.equal(seen.filter(x=>x.p.sourceMode==='file-interaction'&&x.request.reviewPhase==='risk-planning').length,1);assert.equal(interaction.length,2);assert.equal(interaction[1].p.retrievalBudget.remainingCalls,interaction[0].p.retrievalBudget.remainingCalls-1);
 const primarySource=seen.find(x=>x.p.file?.id==='f0'&&x.p.retrieved.length).p.retrieved[0].result.sourceId;assert.notEqual(interaction[1].p.retrieved[0].result.sourceId,primarySource,'later interaction reads a distinct approved source, not earlier bodies as evidence');
 assert.equal(report.retrievalUsage.outputBytes,report.files[0].retrievalAudit.reduce((n,item)=>n+item.resultBytes,0)+Buffer.byteLength(JSON.stringify(interaction[1].p.retrieved[0].result)));
 assert.equal(report.files[1].riskPlans.length,2);assert.equal(report.files[1].riskPlans[0].method,'inline');assert.equal(report.files[1].riskPlans[1].sourceMode,'file-interaction');assert.equal(report.files[1].riskPlans[1].status,'completed');assert.equal(report.files[1].riskPlans[1].groupId,report.grouping.groups[0].id);assert.equal(report.modelCalls,12);assert.equal(report.status,'completed');
 assert.ok(!report.limitations.some(l=>l.text.includes('跨文件综合未完成')));
});
