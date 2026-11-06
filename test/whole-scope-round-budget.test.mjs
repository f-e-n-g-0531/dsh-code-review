import test from'node:test';
import assert from'node:assert/strict';
import{prepareWholeScope}from'../src/whole-scope-plan.mjs';
import{initialRetrievalEnvelope}from'../src/retrieval-initial-envelope.mjs';
import{modelWireBudget,configureWireBudget}from'../src/model-wire-budget.mjs';
const snapshot={id:'s',files:[{id:'f',path:'a.js',eligibility:'reviewable',properties:[],left:{text:'old();'},right:{text:'new();'}}],context:[],rules:[]};
for(const maxRetrievalRounds of[0,3,10])test('whole direct exact boundary uses actual retrieval rounds '+maxRetrievalRounds,()=>{
 const scope=configureWireBudget({catalog:()=>[],budget:()=>({remainingCalls:5,remainingOutputBytes:50000})},{nativeOutputTools:true});const options={instructions:'review',scope,maxRetrievalRounds};
 const b=prepareWholeScope(snapshot,options).batches[0];const actual=initialRetrievalEnvelope({input:b.payload,instructions:b.instructions,nativeOutputTools:true},scope,{maxRounds:maxRetrievalRounds});const bytes=modelWireBudget(actual,Number.MAX_SAFE_INTEGER).bytes;
 assert.equal(prepareWholeScope(snapshot,{...options,maxInputBytes:bytes}).batches.length,1);const over=prepareWholeScope(snapshot,{...options,maxInputBytes:bytes-1});assert.equal(over.batches.length,0);assert.equal(over.oversized[0].requiredBytes,bytes);
});
