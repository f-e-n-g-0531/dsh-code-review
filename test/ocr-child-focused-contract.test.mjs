import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewChildPrompt, measureChildInitialInput } from '../src/child-input-budget.mjs';
const scope={catalog:()=>[],budget:()=>({remainingCalls:10,remainingOutputBytes:10000})};
test('focused child prompt never claims windows are complete member bodies and measurement uses actual prompt',()=>{
 const request={instructions:'review',input:JSON.stringify({snapshotId:'s',sourceMode:'group-primary',primaryInputMode:'focused',reviews:[{fileId:'f',file:{id:'f'},changes:{status:'changed',precision:'exact',edits:[]}}]})};
 const prompt=buildReviewChildPrompt(request,scope);assert.match(prompt,/not complete files/);assert.doesNotMatch(prompt,/The complete member bodies already/);
 const measurement=measureChildInitialInput(request,scope,{maxInputBytes:200000,hostReserveBytes:0});assert.equal(measurement.fits,true);assert.ok(measurement.requiredBytes>=Buffer.byteLength(prompt));
});
