import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMigrationContracts } from '../src/migration-contracts.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { verificationLoop } from '../src/verification-loop.mjs';

function fixture() {
  const old = `#include "Gate.h"
#include "Worker.h"
void Gate::Run(Worker& worker, int value) {
  if (value < 0) { return; }
  worker.Run(value);
}
`;
  const current = `#include "Gate.h"
void Gate::Run(Worker& worker, int value) {
  shared = value;
  if (value < 0) { return; }
}
`;
  const baseline = `#include "Worker.h"
void Worker::Run(int value) {
  shared = value;
  if (value < 0) { return; }
}
`;
  const file = (id,path,left,right) => ({id,path,eligibility:'reviewable',properties:[],left:{text:left},right:{text:right}});
  const headers = [['Gate.h',`class Gate {
public:
 void Run(Worker& worker, int value);
 int shared;
};
`],['Worker.h',`class Worker {
public:
 void Run(int value);
 int shared;
};
`]];
  const snapshot = {id:'roundtrip',files:[file('gate','Gate.cpp',old,current),file('worker','Worker.cpp',baseline,baseline)],context:headers.map(([path,text])=>({path,text,oldText:text,oldRevision:'b',revision:'t'})),history:{base:'b',target:'t'}};
  const contract = buildMigrationContracts(snapshot).contracts.find(c=>c.kind==='old-delegation');
  assert.ok(contract);
  const role = contract.new[0];
  const candidate = {fileId:'gate',anchor:{kind:'line',side:'new',start:role.line,end:role.line},attribution:{status:'references-validated',editIds:role.editIds}};
  return {snapshot,contract,candidate};
}

test('same scripted verifier reaches original validated comparison with one fewer model roundtrip', async () => {
  const counts = [];
  for (const prefetch of [false,true]) {
    const {snapshot,contract,candidate} = fixture();
    const scope = createRetrievalScope(snapshot);
    const roles = [contract.old[0],contract.new[0],contract.baseline[0]];
    let calls=0;
    // A deterministic transport fixture, NOT a model-quality or real-latency benchmark.
    const model = async request => {
      calls++;
      const payload=JSON.parse(request.input);
      const reads=(payload.retrieved??[]).map(item=>item.result);
      const evidence=roles.map(role=>reads.find(r=>r?.sourceId===role.sourceId&&r.start<=role.startLine&&r.start+r.count>role.endLine));
      if(evidence.some(r=>!r)) return {requests:roles.map(role=>({kind:'read',id:role.sourceId,start:role.startLine,count:role.endLine-role.startLine+1}))};
      return {verdicts:[{candidateId:'c1',verdict:'supported',reason:'Same rejected input now writes state before its public gate.',evidence:evidence.map(r=>({receiptId:r.receiptId})),regression:{classification:'introduced',reason:'The old gate rejects before delegated mutation; the new entry mutates before rejection.',oldEvidence:[0,2],newEvidence:[1],migrationContractId:contract.id}}]};
    };
    const reader = prefetch ? scope : {...scope,transaction:undefined};
    const result=await verificationLoop(model,{input:JSON.stringify({snapshotId:snapshot.id}),instructions:'review'},[candidate],reader,{enableMigrationRegression:true,migrationSnapshot:snapshot,migrationContracts:[contract],maxRounds:3,maxInputBytes:98304});
    assert.equal(result[0].regression.classification,'introduced');
    assert.equal(result[0].causality,'unverified');
    assert.ok(result[0].evidence.every(ref=>ref.status==='references-validated'));
    counts.push(calls);
  }
  assert.deepEqual(counts,[2,1]);
});

test('final-only verification makes no optional migration reads or receipts', async () => {
  const {snapshot,contract,candidate}=fixture();
  const scope=createRetrievalScope(snapshot); let events=0;
  const result=await verificationLoop(async request=>{
    assert.equal((JSON.parse(request.input).retrieved??[]).length,0);
    return {verdicts:[{candidateId:'c1',verdict:'uncertain',reason:'No approved evidence was read.',evidence:[]}]};
  },{input:JSON.stringify({snapshotId:snapshot.id}),instructions:'review'},[candidate],scope,{enableMigrationRegression:true,migrationSnapshot:snapshot,migrationContracts:[contract],maxRounds:0,onMigrationSeeds:()=>events++});
  assert.equal(result[0].verdict,'uncertain');
  assert.deepEqual(scope.usage(),{calls:0,outputBytes:0});
  assert.equal(events,0);
});
