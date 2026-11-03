import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewSnapshot} from '../src/review.mjs';
import {buildResumeState,validateResumeState} from '../src/review-resume.mjs';
import {interactionCases} from './fixtures/interaction-cases.mjs';

const snapshot=()=>({id:'continuation-snapshot',vcs:'git',context:[],files:Array.from({length:3},(_,i)=>({id:'f'+(i+1),path:'file'+(i+1)+'.js',eligibility:'reviewable',properties:[],left:{text:'safe();\n'},right:{text:'unsafe();\n'}}))});
const finding=()=>({fileId:'f1',severity:'high',title:'Unchecked operation',evidence:'Guard removed',trigger:'Invalid input',impact:'Operation fails',suggestion:'Restore guard',anchor:{kind:'line',side:'new',start:1,end:1,snippet:'unsafe();'}});
const options={enableRetrieval:true,enableVerification:true,enableStageContinuation:true,readerBudgetPolicy:'fixed',changesConcurrency:1,maxRetrievalRounds:10,timeoutMs:5000};
const batch=prefix=>({requests:Array.from({length:8},(_,i)=>({kind:'find',query:prefix+'-'+i,limit:1}))});

async function run({mode='success',enabled=true}={}){
 const primary=new Map(),attempts=[],calls=[];let epoch=0,query=0;
 const report=await reviewSnapshot(snapshot(),async request=>{
  const p=JSON.parse(request.input);calls.push({phase:request.reviewPhase,purpose:request.callPurpose});
  if(request.reviewPhase!=='verification'){
   assert.ok(p.file,'fixture does not enable business/group primary stages');const id=p.file.id;primary.set(id,(primary.get(id)??0)+1);
   return {findings:id==='f1'?[finding()]:[],limitations:[]};
  }
  if(request.callPurpose==='primary-initial'){
   epoch++;const seed=p.retrieved.find(item=>item.result.receiptId)?.result;assert.ok(seed,'fresh verifier host prefetch expected');attempts.push({receipt:seed.receiptId,seed,seen:p.retrieved.map(item=>item.result.receiptId).filter(Boolean)});
  }
  if(mode==='root-exhaust' || epoch===1)return batch('miss-'+(++query));
  const current=attempts.at(-1);assert.notEqual(current.receipt,attempts[0].receipt);
  assert.ok(!p.retrieved.some(item=>item.result.receiptId===attempts[0].receipt),'old verifier receipt not delivered to resumed verifier');
  return {verdicts:[{candidateId:'c1',verdict:'supported',reason:'Checked fresh approved source',evidence:[{receiptId:mode==='foreign-receipt'?attempts[0].receipt:current.receipt}]}]};
 },{...options,enableStageContinuation:enabled});
 return {report,primary,attempts,calls};
}

test('real review yields early verifier until other file floors release, resumes only verification with fresh receipt',async()=>{
 const {report,primary,attempts,calls}=await run();
 assert.deepEqual([...primary],[['f1',1],['f2',1],['f3',1]]);
 assert.equal(attempts.length,2);assert.notEqual(attempts[0].receipt,attempts[1].receipt);
 assert.equal(report.findings.length,1);assert.equal(report.findings[0].verification.status,'completed');assert.equal(report.findings[0].verification.verdict,'supported');
 assert.equal(report.findings[0].verification.evidence[0].text,'unsafe();\n');
 assert.equal(report.readerBudget.maxCalls,50);assert.ok(report.readerBudget.calls>17&&report.readerBudget.calls<=50);
 assert.equal(report.stageContinuation.completed,1);assert.equal(report.stageContinuation.pending,0);assert.equal(report.stageContinuation.attempts,1);
 assert.equal(calls.filter(c=>c.phase==='verification'&&c.purpose==='primary-initial').length,2);
 assert.ok(!report.files.some(f=>f.continuationPending));
 assert.equal(report.files.find(f=>f.fileId==='f1').resumeEligible,true);
});

test('root exhausted or no-progress verification remains bounded pending rather than successful',async()=>{
 const {report,primary,attempts,calls}=await run({mode:'root-exhaust'});
 assert.deepEqual([...primary.values()],[1,1,1]);assert.ok(attempts.length<=3);assert.ok(calls.length<=20);
 assert.equal(report.readerBudget.maxCalls,50);assert.equal(report.readerBudget.calls,50);
 assert.notEqual(report.findings[0].verification.status,'completed');assert.equal(report.status,'partial');
 assert.ok(report.stageContinuation.pending>0);assert.ok(report.stageContinuation.attempts<=2);assert.ok(report.files.some(f=>f.continuationPending));
});

test('fresh resumed verifier cannot validate a receipt retained from the yielded invocation',async()=>{
 const {report,primary,attempts}=await run({mode:'foreign-receipt'});
 assert.deepEqual([...primary.values()],[1,1,1]);assert.equal(attempts.length,2);
 assert.equal(report.findings[0].verification.status,'incomplete');assert.notEqual(report.status,'completed');
 assert.ok(report.limitations.some(l=>/复核未完成/.test(l.text)));assert.ok(report.readerBudget.calls<=50);
 assert.equal(report.stageContinuation.completed,0);assert.equal(report.stageContinuation.pending,1);assert.equal(report.stageContinuation.stopped,1);
});

test('disabled continuation never retries a verifier or replays completed primary generations',async()=>{
 const {report,primary,attempts}=await run({enabled:false});
 assert.deepEqual([...primary.values()],[1,1,1]);assert.equal(attempts.length,1);assert.equal(report.stageContinuation,undefined);
 assert.equal(report.findings[0].verification.status,'incomplete');assert.equal(report.status,'partial');assert.ok(report.readerBudget.calls<=50);
});

test('actual schema2 checkpoint resumes accepted primary without generation and verifies against a fresh reader',async()=>{
 const first=await run({mode:'root-exhaust'}),input=snapshot();
 assert.equal(first.report.readerBudget.calls,50);assert.equal(first.report.findings[0].verification.status,'incomplete');
 const checkpoint=buildResumeState(input,options,first.report);assert.equal(checkpoint.schemaVersion,2);assert.ok(checkpoint.stageGenerations.some(row=>row.fileId==='f1'));
 assert.ok(!JSON.stringify(checkpoint).includes('receiptId'));const state=validateResumeState(JSON.parse(JSON.stringify(checkpoint)),input,options);
 let primaryCalls=0,verificationCalls=0;const oldReceipts=new Set(first.attempts.map(item=>item.receipt));
 const second=await reviewSnapshot(input,async request=>{
  if(request.reviewPhase!=='verification'){primaryCalls++;return{findings:[],limitations:[]};}
  verificationCalls++;const p=JSON.parse(request.input),seed=p.retrieved.find(item=>item.result.receiptId)?.result;
  assert.ok(seed);assert.ok(!oldReceipts.has(seed.receiptId));
  return{verdicts:[{candidateId:'c1',verdict:'supported',reason:'Fresh resumed source',evidence:[{receiptId:seed.receiptId}]}]};
 },{...options,resumeState:state});
 assert.equal(primaryCalls,0);assert.equal(verificationCalls,1);assert.equal(second.findings[0].verification.status,'completed');assert.equal(second.findings.length,1);
 assert.ok(second.readerBudget.calls>0&&second.readerBudget.calls<50);assert.equal(second.readerBudget.maxCalls,50);
});

test('two window generations sharing a yielded verification unit resume without releasing each other early',async()=>{
 const input=snapshot(),lines=Array.from({length:100},(_,i)=>'line'+i+'x'.repeat(200)),changed=[...lines];changed[10]='changed10';changed[80]='changed80';
 input.files[0].left.text=lines.join('\n');input.files[0].right.text=changed.join('\n');
 const primary=new Map(),verifierStarts=[],verified=[];let query=0;
 const report=await reviewSnapshot(input,async request=>{
  const p=JSON.parse(request.input);
  if(request.reviewPhase==='verification'){
   const seed=p.retrieved.find(item=>item.result.receiptId)?.result;assert.ok(seed);
   if(request.callPurpose==='primary-initial')verifierStarts.push(seed.receiptId);
   if(verifierStarts.length===1)return batch('windows-'+(++query));
   verified.push(p.candidates[0].finding.anchor.start);
   return{verdicts:[{candidateId:'c1',verdict:'supported',reason:'Fresh independent window evidence',evidence:[{receiptId:seed.receiptId}]}]};
  }
  if(request.reviewPhase==='window-synthesis')return{findings:[],limitations:[]};
  const id=p.file.id;primary.set(id,(primary.get(id)??0)+1);
  if(id!=='f1')return{findings:[],limitations:[]};
  assert.equal(p.windows.length,1);const window=p.windows[0],start=window.new.start+window.new.text.split('\n').findIndex(line=>line==='changed10'||line==='changed80'),snippet=changed[start-1];
  return{findings:[{...finding(),title:'Window '+start,anchor:{kind:'line',side:'new',start,end:start,snippet},attribution:{editIds:window.editIds,properties:[],beforeBehavior:'guarded',afterBehavior:'unguarded',reason:'changed operation'}}],limitations:[]};
 },{...options,maxInputBytes:11000});
 assert.equal(primary.get('f1'),2);assert.equal(primary.get('f2'),1);assert.equal(primary.get('f3'),1);
 assert.equal(report.findings.length,2);assert.ok(report.findings.every(f=>f.verification.status==='completed'));
 assert.deepEqual(verified.sort((a,b)=>a-b),[11,81]);assert.equal(report.stageContinuation.completed,3);assert.equal(report.stageContinuation.pending,0);
 assert.ok(report.continuation.units.some(unit=>unit.kind==='synthesis' && unit.status==='completed'));
 assert.equal(new Set(verifierStarts).size,verifierStarts.length);assert.ok(report.readerBudget.calls<=50);assert.equal(report.readerBudget.maxCalls,50);
});

test('two rounds sharing a yielded interaction unit queue siblings until unrelated file releases capacity',async()=>{
 const input={id:'interaction-continuation',vcs:'git',context:[],files:interactionCases[0].files.map((file,i)=>({id:'g'+i,path:file.path,eligibility:'reviewable',properties:[],left:{text:file.old},right:{text:file.new}}))};
 input.files.push({id:'late',path:'unrelated.txt',eligibility:'reviewable',properties:[],left:{text:'before'},right:{text:'after'}});
 const primary=new Map(),interactionStarts=[];let query=0,lateDone=false;
 const report=await reviewSnapshot(input,async request=>{
  const p=JSON.parse(request.input);
  if(p.file){primary.set(p.file.id,(primary.get(p.file.id)??0)+1);if(p.file.id==='late')lateDone=true;return{findings:[],limitations:[]};}
  assert.equal(p.sourceMode,'file-interaction');
  if(request.callPurpose==='primary-initial')interactionStarts.push({lateDone});
  if(!lateDone)return batch('interaction-wait-'+(++query));
  return{findings:[],limitations:[]};
 },{...options,enableGrouping:true,reviewRounds:2});
 assert.equal(report.interactions.length,1);assert.equal(report.interactions[0].status,'completed');
 assert.deepEqual([...primary.values()],[2,2,2]);assert.equal(interactionStarts.length,2);assert.ok(interactionStarts.every(row=>row.lateDone));
 assert.equal(report.stageContinuation.completed,2);assert.equal(report.stageContinuation.pending,0);assert.ok(report.readerBudget.calls<=50);assert.equal(report.readerBudget.maxCalls,50);
 assert.ok(report.files.every(file=>!file.stageFailures?.length));assert.ok(report.files.every(file=>file.resumeEligible===true));
 assert.deepEqual([...new Set(report.interactions[0].completedRounds)].sort(),[1,2]);
});

test('a failed second primary round is never promoted by successful earlier generation or deferred verifier',async()=>{
 const primary=new Map();let verificationStarts=0,query=0;
 const report=await reviewSnapshot(snapshot(),async request=>{
  const p=JSON.parse(request.input);
  if(request.reviewPhase==='verification'){
   if(request.callPurpose==='primary-initial')verificationStarts++;
   return batch('defer-before-failed-primary-'+(++query));
  }
  const id=p.file.id,count=(primary.get(id)??0)+1;primary.set(id,count);
  if(id==='f1'&&count===2)return{findings:[{...finding(),fileId:'unapproved-file'}],limitations:[]};
  return{findings:id==='f1'?[finding()]:[],limitations:[]};
 },{...options,reviewRounds:2});
 assert.equal(primary.get('f1'),2);assert.equal(primary.get('f2'),2);assert.equal(primary.get('f3'),2);
 const failed=report.files.find(file=>file.fileId==='f1');assert.equal(failed.status,'failed');assert.equal(failed.resumeEligible,false);
 assert.equal(verificationStarts,1);assert.equal(report.stageContinuation.completed,0);assert.equal(report.stageContinuation.pending,1);
 assert.ok(failed.reviewPasses.some(pass=>pass.round===2&&pass.status==='failed'));assert.notEqual(report.status,'completed');
 assert.equal(report.findings[0].verification.status,'incomplete');assert.ok(report.readerBudget.calls<=50);
});
