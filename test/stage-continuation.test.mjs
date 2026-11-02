import test from 'node:test';
import assert from 'node:assert/strict';
import {createStageContinuation} from '../src/stage-continuation.mjs';
const snapshot={id:'snap',files:[{id:'f1',eligibility:'reviewable',right:{text:'PRIVATE_SOURCE'}},{id:'f2',eligibility:'reviewable'}]};
const options={enableStageContinuation:true,model:'route',rules:['rulehash']};
const units=[{id:'synth',kind:'synthesis',fileIds:['f1'],dependencies:['primary:f1']},{id:'verify',kind:'verification',fileIds:['f1'],dependencies:['synth']},{id:'interaction',kind:'interaction',fileIds:['f1','f2'],dependencies:['verify','primary:f2']}];
const make=extra=>createStageContinuation(snapshot,options,{completedPrimary:['f1','f2'],units,...extra});

test('completed primary is not rerun; dependency stages restart only at safe fresh-evidence boundary',()=>{
 const stage=make(); assert.deepEqual(stage.ready().map(s=>s.id),['synth']);
 const t=stage.start('synth');assert.equal(t.requiresFreshEvidence,true);assert.equal(t.boundary,'stage-start');stage.complete('synth',t.attempt);
 assert.deepEqual(stage.ready().map(s=>s.id),['verify']);const v=stage.start('verify');stage.yield('verify','READER_OUTPUT_BUDGET_EXCEEDED');
 const checkpoint=stage.checkpoint();assert.ok(!JSON.stringify(checkpoint).includes('PRIVATE_SOURCE'));assert.deepEqual(checkpoint.completedPrimary,['f1','f2']);
 const resumed=make({checkpoint});const retry=resumed.start('verify');assert.equal(retry.attempt,2);assert.equal(retry.requiresFreshEvidence,true);resumed.complete('verify',retry.attempt);
 assert.deepEqual(resumed.ready().map(s=>s.id),['interaction']);assert.equal(resumed.summary().completed,2);assert.equal(v.attempt,1);
});

test('identity binds entire snapshot options stage plan attempts and completed primary set',()=>{
 const checkpoint=make().checkpoint();
 for(const [snap,opt,configuration] of [[{...snapshot,id:'different'},options,{}],[{...snapshot,files:[{...snapshot.files[0],right:{text:'changed'}},snapshot.files[1]]},options,{}],[snapshot,{...options,model:'foreign'},{}],[snapshot,options,{maxAttempts:3}],[snapshot,options,{completedPrimary:['f1']}],[snapshot,options,{units:units.slice(0,2)}]])assert.throws(()=>createStageContinuation(snap,opt,{completedPrimary:['f1','f2'],units,...configuration,checkpoint}),{code:'STAGE_CONTINUATION_IDENTITY_MISMATCH'});
});

test('running checkpoint restores interrupted pending, never success or inherited receipts',()=>{
 const stage=make();stage.start('synth');const checkpoint=stage.checkpoint(),restored=make({checkpoint});
 assert.equal(restored.summary().completed,0);assert.equal(restored.ready()[0].pendingReason,'STAGE_INTERRUPTED');assert.equal(restored.start('synth').attempt,2);
 const forged=structuredClone(checkpoint);forged.units[0].receiptId='receipt-private';assert.throws(()=>make({checkpoint:forged}),{code:'INVALID_STAGE_CHECKPOINT'});
 assert.ok(!JSON.stringify(restored.checkpoint()).includes('receipt'));
});

test('all no progress paths stop bounded and retain pending, not fake completed',()=>{
 const stage=make();for(let i=0;i<2;i++){stage.start('synth');stage.yield('synth','STAGE_NO_PROGRESS');}
 assert.deepEqual(stage.ready(),[]);assert.equal(stage.summary().pending,3);assert.equal(stage.summary().completed,0);assert.equal(stage.checkpoint().units[0].pendingReason,'STAGE_ATTEMPTS_EXHAUSTED');
 assert.throws(()=>stage.start('synth'),{code:'STAGE_NOT_READY'});assert.deepEqual(make({checkpoint:stage.checkpoint()}).ready(),[]);
});

test('cancelled and timed out attempts cannot silently complete or reset attempt budget',()=>{
 const c=new AbortController(),reason=new Error('cancel'),stage=make();c.abort(reason);
 assert.throws(()=>stage.start('synth',{signal:c.signal}),e=>e===reason);assert.equal(stage.summary().attempts,0);
 const token=stage.start('synth');assert.throws(()=>stage.complete('synth',token.attempt,{signal:c.signal}),e=>e===reason);assert.equal(stage.summary().completed,0);assert.equal(stage.summary().stopped,1);
 const other=make();other.start('synth');other.stop('synth','STAGE_TIMEOUT');assert.deepEqual(other.ready(),[]);assert.equal(other.checkpoint().units[0].pendingReason,'STAGE_TIMEOUT');
});

test('invalid dependencies cycles unknown primaries and stale completions fail closed',()=>{
 for(const plan of [[{...units[0],dependencies:['missing']}],[{...units[0],dependencies:['primary:foreign']}],[{...units[0],dependencies:['synth']}],[{...units[0],dependencies:['verify']},units[1]]])assert.throws(()=>make({units:plan}),{code:'INVALID_STAGE_DEPENDENCIES'});
 assert.throws(()=>make({completedPrimary:['foreign']}),{code:'INVALID_STAGE_PRIMARY'});
 const stage=make(),token=stage.start('synth');stage.yield('synth');stage.start('synth');assert.throws(()=>stage.complete('synth',token.attempt),{code:'STALE_STAGE_ATTEMPT'});
 assert.deepEqual(createStageContinuation(snapshot,options,{completedPrimary:['f1'],units}).ready().map(s=>s.id),['synth']);
});

test('checkpoints and ready results are copies and no model or source fields escape summary',()=>{
 const stage=make(),a=stage.checkpoint();a.units[0].status='completed';a.completedPrimary.length=0;assert.equal(stage.summary().completed,0);assert.equal(stage.checkpoint().completedPrimary.length,2);
 const ready=stage.ready();ready[0].fileIds.push('foreign');assert.deepEqual(stage.ready()[0].fileIds,['f1']);assert.deepEqual(Object.keys(stage.summary()).sort(),['attempts','completed','pending','running','stopped','units']);
});

test('restored checkpoint cannot mark a dependent stage complete before its prerequisites',()=>{
 const checkpoint=make().checkpoint();checkpoint.units[1].status='completed';checkpoint.units[1].attempts=1;
 assert.throws(()=>make({checkpoint}),{code:'INVALID_STAGE_CHECKPOINT'});
});
