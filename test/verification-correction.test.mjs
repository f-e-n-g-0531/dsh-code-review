import test from 'node:test';
import assert from 'node:assert/strict';
import { verificationLoop } from '../src/verification-loop.mjs';
import { createSnapshotReader } from '../src/snapshot-reader.mjs';
const setup = () => ({ ...createSnapshotReader('snapshot', [{id:'s1',text:'guard();'}]), catalog:()=>[{id:'s1',fileId:'f1',side:'new',lineCount:1}] });
const candidate = {fileId:'f1',anchor:{kind:'line',side:'new',start:1,end:1}};
const uncertain = id => ({candidateId:id,verdict:'uncertain',reason:'Missing old public entry evidence.',evidence:[]});

test('one incomplete batch correction reuses exact original receipts and performs no repeated retrieval', async () => {
  const scope=setup(); let calls=0,admissions=0,original; const events=[];
  const result=await verificationLoop(request=>{
    calls++; const input=JSON.parse(request.input);
    if(calls===1){original=request; return {verdicts:[]};}
    assert.equal(request.input,original.input);
    assert.equal(request.callPurpose,'verification-correction');
    assert.match(request.instructions,/不得再次检索/);
    return {verdicts:[{candidateId:'c1',verdict:'refuted',reason:'The approved guard refutes the candidate.',evidence:[{receiptId:input.retrieved[0].result.receiptId}]}]};
  },{onProtocolEvent:event=>events.push(event)},[candidate],scope,{correctProtocol:true,beforeCall:()=>admissions++});
  assert.equal(result[0].verdict,'refuted');
  assert.equal(result[0].evidence[0].status,'references-validated');
  assert.equal(calls,2); assert.equal(admissions,2);
  assert.equal(scope.usage().calls,2); // one seed + one original final re-read
  assert.deepEqual(events,[{action:'verification-response-correction',code:'MODEL_INCOMPLETE_VERIFICATION'}]);
});

test('correction is opt-in, single-shot and cannot grant further reader operations', async () => {
  for(const correctProtocol of [false,true]){
    let calls=0; const scope=setup();
    await assert.rejects(verificationLoop(()=>{calls++;return {verdicts:[]};},{},[{}],scope,{correctProtocol}),/Incomplete verification/);
    assert.equal(calls,correctProtocol?2:1); assert.equal(scope.usage().calls,0);
  }
  const scope=setup();let calls=0;
  await assert.rejects(verificationLoop(()=>++calls===1?{verdicts:[]}:{requests:[{kind:'read',id:'s1',start:1,count:1}]},{},[{}],scope,{correctProtocol:true}),/Incomplete verification/);
  assert.equal(calls,2);assert.equal(scope.usage().calls,0);
});

test('shared call admission and same abort signal veto correction before model send', async () => {
  for(const abort of [false,true]){
    const controller=new AbortController();let calls=0,admissions=0;
    await assert.rejects(verificationLoop(()=>{calls++;if(abort)controller.abort(Error('cancelled'));return {verdicts:[]};},{signal:controller.signal},[{}],setup(),{correctProtocol:true,beforeCall:()=>{if(++admissions===2)throw Error('shared model limit');}}),abort?/cancelled/:/shared model limit/);
    assert.equal(calls,1);
  }
});

test('bad identities and fabricated receipts are never corrected or converted to uncertain', async () => {
  for(const bad of [{...uncertain('foreign')},{candidateId:'c1',verdict:'supported',reason:'invented',evidence:[{receiptId:'fake'}]}]){
    let calls=0;
    await assert.rejects(verificationLoop(()=>{calls++;return {verdicts:[bad]};},{},[{}],setup(),{correctProtocol:true}));
    assert.equal(calls,1);
  }
});

test('missing batch cannot hide invalid identities receipts or regression', async () => {
 for(const verdicts of [[uncertain('foreign')],[uncertain('c1'),uncertain('c1')],[{candidateId:'c1',verdict:'supported',reason:'fake',evidence:[{receiptId:'fake'}]}],[{...uncertain('c1'),regression:{classification:'invalid'}}]]) {
  let calls=0;
  await assert.rejects(verificationLoop(()=>{calls++;return {verdicts};},{},[{},{},{}],setup(),{correctProtocol:true}));
  assert.equal(calls,1);
 }
});

test('missing batch members stay host ordered and no evidence is fabricated for uncertainty', async () => {
  let calls=0;const scope=setup();
  const result=await verificationLoop(()=>++calls===1?{verdicts:[uncertain('c1')]}:{verdicts:[uncertain('c2'),uncertain('c1')]},{},[{},{}],scope,{correctProtocol:true});
  assert.deepEqual(result.map(r=>r.candidateId),['c1','c2']);
  assert.ok(result.every(r=>r.verdict==='uncertain'&&r.evidence.length===0));
  assert.equal(scope.usage().calls,0);
});
