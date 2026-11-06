import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewSnapshot } from '../src/review.mjs';
import { buildMigrationContracts } from '../src/migration-contracts.mjs';
const file=(id,old,current)=>({id,path:id+'.js',eligibility:'reviewable',properties:[],left:{text:old},right:{text:current}});
const oldEntry='export function Public(state) {\n  if (!state.allowed) { return; }\n  state.value++;\n}\n';
const newEntry='export function Public(state) {\n  state.value++;\n}\n';
const oldImpl='export function Preload(state) {\n  state.ready = true;\n}\n';
const newImpl='import { Public } from "./A.js";\nexport function Preload(state) {\n  if (!state.allowed) { return; }\n  Public(state);\n}\n';
const caller='import { Public } from "./A.js";\nexport function Run(state) {\n  Public(state);\n}\n';
function fixture(){const snapshot={id:'staged-counter-migration',vcs:'git',root:'/repo',context:[],files:[file('A',oldEntry,newEntry),file('B',oldImpl,newImpl),file('C',caller,caller)]};const contract=buildMigrationContracts(snapshot).contracts[0];assert.ok(contract);const role=contract.new[0];return{snapshot,contract,finding:{fileId:'B',severity:'high',title:'Moved guard leaves old public entry exposed',evidence:'Guard moved into preloader',trigger:'Caller uses old public entry',impact:'Mutation bypasses guard',suggestion:'Retain public entry guard',anchor:{kind:'line',side:'new',start:role.line,end:role.line,snippet:newImpl.split('\n')[role.line-1]},attribution:{editIds:[...role.editIds],properties:[],beforeBehavior:'public guarded',afterBehavior:'public unguarded',reason:'guard relocation'}}};}
async function run({enabled=true,foreignContract=false,foreignReceipt=false}={}){
 const {snapshot,contract,finding}=fixture(),receiptSets={baseline:new Set(),counter:new Set()};let primary=0,counterCalls=0,baselineCalls=0;
 const report=await reviewSnapshot(snapshot,request=>{
  const p=JSON.parse(request.input);
  if(request.reviewPhase!=='verification'){primary++;return{findings:p.file?.id==='B'?[finding]:[],limitations:[]};}
  const counter=request.instructions.includes('独立反证复核');if(counter)counterCalls++;else baselineCalls++;
  if(enabled)assert.equal(p.migrationContracts[0].id,contract.id);else assert.equal(p.migrationContracts,undefined);
  if(counter){assert.equal(p.candidates[0].finding.verification,undefined);assert.equal(p.candidates[0].finding.counterVerification,undefined);}
  const roles=[contract.old[0],contract.new[0]],missing=roles.filter(role=>!p.retrieved.some(row=>row.result.sourceId===role.sourceId));
  if(missing.length)return{requests:missing.map(role=>({kind:'read',id:role.sourceId,start:role.line,count:1}))};
  const refs=roles.map(role=>p.retrieved.find(row=>row.result.sourceId===role.sourceId).result);
  for(const ref of refs){assert.ok(ref.receiptId);assert.equal(ref.snapshotId,snapshot.id);receiptSets[counter?'counter':'baseline'].add(ref.receiptId);}
  const regression={classification:'introduced',reason:'Explicit old/new public entry comparison',oldEvidence:[0],newEvidence:[1],...(enabled?{migrationContractId:counter&&foreignContract?'invented-contract':contract.id}:{})};
  return{verdicts:[{candidateId:p.candidates[0].candidateId,verdict:'supported',reason:'Fresh approved source evidence',evidence:refs.map(ref=>({receiptId:counter&&foreignReceipt?'prior-stage-receipt':ref.receiptId})),regression}]};
 },{enableRetrieval:true,enableVerification:true,enableCounterVerification:true,enableMigrationContracts:true,enableMigrationRegression:enabled,enableRiskPlanning:false,enableGrouping:false,enableGroupPrimary:false,enablePrimarySeeds:false,changesConcurrency:1,maxRetrievalRounds:3});
 return{report,receiptSets,counterCalls,baselineCalls,primary,contract};
}
test('staged baseline and counter both keep explicit migration roles and independent fresh receipts',async()=>{
 const r=await run(),v=r.report.findings[0].verification;
 assert.equal(v.status,'completed',JSON.stringify(r.report.limitations));assert.equal(v.verdict,'supported');assert.equal(v.regression.classification,'introduced');assert.equal(v.regression.migrationContractId,r.contract.id);
 assert.equal(v.counterVerification.status,'completed');assert.equal(v.counterVerification.result.regression.classification,'introduced');assert.equal(v.counterVerification.result.regression.migrationContractId,r.contract.id);
 assert.equal(v.counterVerification.baselineResult.verdict,'supported');assert.ok(r.counterCalls>0);assert.ok(r.baselineCalls>0);assert.equal(r.primary,3);
 assert.ok(r.receiptSets.baseline.size>0);assert.ok(r.receiptSets.counter.size>0);assert.ok([...r.receiptSets.counter].every(id=>!r.receiptSets.baseline.has(id)));
 assert.equal(v.causality,'unverified');
});
test('disabled migration retains strict same-primary rejection and never launches counter',async()=>{
 const r=await run({enabled:false});assert.equal(r.report.findings[0].verification.status,'incomplete');assert.equal(r.counterCalls,0);
 assert.ok(r.report.limitations.some(row=>/side or primary mismatch/.test(row.text)));
});
for(const mutation of [{foreignContract:true},{foreignReceipt:true}])test('counter foreign authority cannot preserve supported aggregate '+Object.keys(mutation)[0],async()=>{
 const r=await run(mutation),v=r.report.findings[0].verification;
 assert.equal(v.status,'incomplete');assert.equal(v.verdict,'uncertain');assert.equal(v.counterVerification.status,'incomplete');assert.equal(v.counterVerification.baselineResult.verdict,'supported');
 assert.equal(v.counterVerification.baselineResult.regression.migrationContractId,r.contract.id);
});
