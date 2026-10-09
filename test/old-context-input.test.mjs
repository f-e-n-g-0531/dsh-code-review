import {verificationLoop} from '../src/verification-loop.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {preparePrimaryInput} from '../src/primary-input.mjs';
import {prepareInteractionInput} from '../src/interaction-input.mjs';
import {createRetrievalScope} from '../src/retrieval-scope.mjs';
import {hash} from '../src/content.mjs';
import {CONTEXT_SIDE_NOTICE} from '../src/context-identity.mjs';
const files=['a.ts','b.ts'].map((path,i)=>({id:'f'+i,path,eligibility:'reviewable',left:{text:'const x=1;'},right:{text:'const x=2;'}}));
const snapshot={id:'snap',history:{base:'a'.repeat(40),target:'b'.repeat(40)},files,context:[{path:'helper.ts',oldOnly:true,oldText:'const helper=1;',oldRevision:'a'.repeat(40),oldBlobOid:'c'.repeat(40),oldHash:hash('const helper=1;')}]};
test('historical primary and interaction notices remain inside measured payload with no fabricated target context',()=>{
 const scope=createRetrievalScope(snapshot);
 const primary=preparePrimaryInput(snapshot,files[0],{instructions:'review',scope,maxInputBytes:96*1024});
 assert.equal(JSON.parse(primary.payload).contextSideNotice,CONTEXT_SIDE_NOTICE);assert.equal(JSON.parse(primary.payload).context[0].text,undefined);assert.ok(primary.budget.bytes>Buffer.byteLength(CONTEXT_SIDE_NOTICE));
 let measured;const group={id:'g',fileIds:['f0','f1']};const interaction=prepareInteractionInput(snapshot,group,payload=>{measured=payload;return {fits:true,bytes:Buffer.byteLength(payload)};});
 assert.equal(measured,interaction.payload);assert.equal(JSON.parse(measured).contextSideNotice,CONTEXT_SIDE_NOTICE);
 assert.equal(prepareInteractionInput(snapshot,group,()=>({fits:false,bytes:999999})).status,'blocked');
 assert.deepEqual(scope.catalog().filter(c=>c.path==='helper.ts').map(c=>c.side),['context-old']);
});
test('verification preserves exact baseline receipts without implying target regression',async()=>{
 const scope=createRetrievalScope(snapshot),id=scope.catalog().find(c=>c.path==='helper.ts').id;
 const model=async request=>{const input=JSON.parse(request.input);assert.equal(input.contextSideNotice,CONTEXT_SIDE_NOTICE);
 if(!input.retrieved.length)return {requests:[{kind:'read',id,start:1,count:1}]};
 return {verdicts:[{candidateId:'c1',verdict:'uncertain',reason:'Baseline does not prove target behavior',evidence:[{receiptId:input.retrieved[0].result.receiptId}]}]};};
 const result=await verificationLoop(model,{},[{fileId:'f0'}],scope);
 assert.equal(result[0].evidence[0].text,'const helper=1;');assert.equal(result[0].regression.classification,'unassessed');
 await assert.rejects(verificationLoop(()=>assert.fail('unexpected send'),{},[{fileId:'f0'}],createRetrievalScope(snapshot),{maxInputBytes:1}),/input budget/);
});
