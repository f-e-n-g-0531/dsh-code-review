import test from 'node:test';
import assert from 'node:assert/strict';
import {createDshModel} from '../src/dsh-model.mjs';
test('actual DSH adapter retains verification correction purpose in lifecycle metrics', async()=>{
 const events=[];
 const model=createDshModel({async *stream(){yield {type:'text-delta',index:0,text:'{"verdicts":[]}'};yield {type:'finish',reason:{kind:'stop'}};}},{provider:'offline',model:'none'});
 await model({instructions:'verification',input:'{}',reviewPhase:'verification',callPurpose:'verification-correction',onModelEvent:event=>events.push(event)});
 assert.equal(events.length,2);
 assert.ok(events.every(event=>event.callPurpose==='verification-correction'));
});
