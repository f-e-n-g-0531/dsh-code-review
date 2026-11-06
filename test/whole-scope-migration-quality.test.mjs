import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewWholeScope } from '../src/whole-scope-review.mjs';
import { validateFindings } from '../src/review.mjs';
import { prepareWholeScope } from '../src/whole-scope-plan.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { buildMigrationContracts } from '../src/migration-contracts.mjs';
import { configureWireBudget } from '../src/model-wire-budget.mjs';
import { initialInputBudget } from '../src/input-budget.mjs';
const fn=(name,body)=>'export function '+name+'(state) {\n'+body+'\n}\n';
function snapshot(){return{id:'whole-migration',vcs:'git',root:'/repo',context:[],files:[
 {id:'a',path:'public.mjs',old:fn('mutate','  if (!state.allowed) { return; }\n  state.value++;'),next:fn('mutate','  state.value++;')},
 {id:'b',path:'preload.mjs',old:fn('preload','  state.ready = true;'),next:'import { mutate } from "./public.mjs";\n'+fn('preload','  if (!state.allowed) { return; }\n  mutate(state);')},
 {id:'c',path:'caller.mjs',old:'import { mutate } from "./public.mjs";\n'+fn('run','  mutate(state);'),next:'import { mutate } from "./public.mjs";\n'+fn('run','  mutate(state);')}
].map(f=>({id:f.id,path:f.path,eligibility:'reviewable',properties:[],left:{text:f.old},right:{text:f.next}}))};}
const candidate={fileId:'b',severity:'high',title:'Public gate moved',evidence:'Changed public behavior',trigger:'disallowed state',impact:'state mutation',suggestion:'retain public guard',anchor:{kind:'line',side:'new',start:3,end:3,snippet:'  if (!state.allowed) { return; }'},attribution:{editIds:['e1'],properties:[],beforeBehavior:'public guarded',afterBehavior:'unguarded public',reason:'guard moved'}};
const role=buildMigrationContracts(snapshot()).contracts[0].new[0];
candidate.anchor={kind:'line',side:'new',start:role.line,end:role.line,snippet:snapshot().files[1].right.text.split('\n')[role.line-1]};
candidate.attribution.editIds=[...role.editIds];
const options={nativeOutputTools:true,validateFindingResponse:validateFindings,enableMigrationContracts:true,enableMigrationRegression:true,maxInputBytes:98304};
function model({disabled=false,foreign=false,counter=false,omitIdentity=false,foreignReceipt=false}={}){let verify=0;return req=>{
 const p=JSON.parse(req.input);
 if(req.reviewPhase==='group-primary'){
  if(!disabled){assert.equal(p.migrationContracts.length,1);assert.equal(p.migrationContracts[0].status,'navigation-only');}
  else assert.equal(p.migrationContracts,undefined);
  return{reviews:p.reviews.map(row=>({fileId:row.fileId,findings:row.fileId==='b'?[candidate]:[],limitations:[]})),limitations:[]};
 }
 verify++;if(counter&&verify>2)assert.match(req.instructions,/独立反证复核/);
 if(disabled){assert.equal(p.migrationContracts,undefined);return{verdicts:[{candidateId:'c1',verdict:'uncertain',reason:'No migration authority',evidence:[]}]};}
 const contract=p.migrationContracts[0];assert.ok(contract);
 const roles=[contract.old[0],contract.new[0]], sources=roles.map(role=>p.catalog.find(s=>s.id===role.sourceId));
 const refs=roles.map(role=>p.retrieved.find(row=>row.result.sourceId===role.sourceId)?.result);
 if(refs.some(x=>!x))return{requests:roles.filter((role,i)=>!refs[i]).map((role,i)=>({kind:'read',id:role.sourceId,start:1,count:sources[roles.indexOf(role)].lineCount}))};
 const evidence=refs.map(ref=>({receiptId:foreignReceipt?'not-issued-in-this-verification':ref.receiptId}));
 return{verdicts:[{candidateId:'c1',verdict:'supported',reason:'Fresh explicit entry comparison',evidence,regression:{classification:'introduced',reason:'Compared same public gate trigger',oldEvidence:[0],newEvidence:[1],...(omitIdentity?{}:{migrationContractId:foreign?'invented':contract.id})}}]};
};}
test('whole primary exposes host navigation and strict independent cross-file receipts can classify introduced',async()=>{
 const s=snapshot(),before=structuredClone(s);const r=await reviewWholeScope(s,model(),options);
 assert.equal(r.migrationContracts.contracts.length,1);assert.match(r.migrationContracts.limitations[0],/not semantic migration/);
 assert.equal(r.findings[0].verification.status,'completed',JSON.stringify(r.orchestration.verifications));
 assert.equal(r.findings[0].verification.regression.classification,'introduced');assert.equal(r.findings[0].verification.regression.status,'comparison-references-validated');
 assert.ok(r.findings[0].verification.evidence.every(ref=>ref.status==='references-validated'));assert.equal(r.modelCalls,3);assert.deepEqual(s,before);
});
test('counter verification retains the same host migration capability with new receipts',async()=>{
 const r=await reviewWholeScope(snapshot(),model({counter:true}),{...options,enableCounterVerification:true});
 assert.equal(r.findings[0].verification.verdict,'supported');assert.equal(r.findings[0].verification.counterVerification.status,'completed');
 assert.equal(r.findings[0].verification.counterVerification.result.regression.classification,'introduced');assert.equal(r.modelCalls,5);
});
test('disabled flags emit no migration hints and do not gain cross-file authority',async()=>{
 const r=await reviewWholeScope(snapshot(),model({disabled:true}),{...options,enableMigrationContracts:false,enableMigrationRegression:false});
 assert.equal(r.migrationContracts,undefined);assert.equal(r.findings[0].verification.verdict,'uncertain');
});
test('foreign contract identity remains a failed verification, not repaired supported evidence',async()=>{
 const r=await reviewWholeScope(snapshot(),model({foreign:true}),options);
 assert.equal(r.orchestration.verifications[0].status,'failed');assert.equal(r.findings[0].verification.status,'incomplete');
});
test('missing migration identity cannot bypass same-primary checks and foreign receipts stay invalid',async()=>{
 for(const mutation of [{omitIdentity:true},{foreignReceipt:true}]){
  const r=await reviewWholeScope(snapshot(),model(mutation),options);
  assert.equal(r.findings[0].verification.status,'incomplete');assert.equal(r.orchestration.verifications[0].status,'failed');
 }
});
test('unsupported navigation never manufactures relationships',()=>{
 const s=snapshot();s.files[1].right.text='/* unsupported */\n'+s.files[1].right.text;
 const p=prepareWholeScope(s,{instructions:'review',scope:createRetrievalScope(s),enableMigrationContracts:true});
 assert.equal(JSON.parse(p.batches[0].payload).migrationContracts,undefined);
});
test('migration hints are included in exact measured planning boundaries',()=>{
 const s=snapshot(),scope=configureWireBudget(createRetrievalScope(s),{nativeOutputTools:true});
 const opts={instructions:'review',scope,enableMigrationContracts:true,maxRetrievalRounds:3};
 const p=prepareWholeScope(s,opts),batch=p.batches[0];assert.ok(JSON.parse(batch.payload).migrationContracts.length);
 const measured=initialInputBudget({input:batch.payload,instructions:batch.instructions,maxRetrievalRounds:3,nativeOutputTools:true},scope,1000000);
 assert.equal(prepareWholeScope(s,{...opts,maxInputBytes:measured.bytes}).batches.length,1);
 const lower=prepareWholeScope(s,{...opts,maxInputBytes:measured.bytes-1});assert.ok(lower.batches.length!==1||lower.batches[0].fileIds.length!==3);
 const plain=prepareWholeScope(s,{instructions:'review',scope}).batches[0];assert.ok(Buffer.byteLength(batch.payload)>Buffer.byteLength(plain.payload));
});
