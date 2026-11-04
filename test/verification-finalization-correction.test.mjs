import test from 'node:test';
import assert from 'node:assert/strict';
import { verificationLoop } from '../src/verification-loop.mjs';
import { createSnapshotReader } from '../src/snapshot-reader.mjs';
test('explicit final-only single answer is not extended by incomplete batch correction', async () => {
 const scope={...createSnapshotReader('s',[]),catalog:()=>[]};let calls=0;
 await assert.rejects(verificationLoop(()=>{calls++;return {verdicts:[]};},{},[{}],scope,{correctProtocol:true,maxRounds:0}),/Incomplete verification response/);
 assert.equal(calls,1);assert.equal(scope.usage().calls,0);
});
