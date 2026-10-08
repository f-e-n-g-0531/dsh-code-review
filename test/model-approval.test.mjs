import test from 'node:test';
import assert from 'node:assert/strict';
import { requestModelApproval } from '../src/model-approval.mjs';
test('only literal host allowed-once grants and request identity signal remain intact',async()=>{
 const request={agent:{},signal:new AbortController().signal,toolName:'code_review_execute'};let seen;
 assert.equal(await requestModelApproval({request:async r=>{seen=r;return 'allowed-once';}},request),true);assert.equal(seen,request);
});
test('rejected cancelled unavailable missing and malformed outcomes fail closed with actionable diagnostics',async()=>{
 for(const outcome of ['rejected','cancelled','unavailable',true,undefined,'allowed-always'])await assert.rejects(requestModelApproval({request:async()=>outcome},{}),/no code sent.*review not performed/);
 await assert.rejects(requestModelApproval({},{}),/service missing/);
 await assert.rejects(requestModelApproval({request:async()=>{throw Error('host failure');}},{}),/host failure/);
});
