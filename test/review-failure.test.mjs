import test from 'node:test';
import assert from 'node:assert/strict';
import { safeReviewFailure } from '../src/review-failure.mjs';
import { ChildInputCapacityError } from '../src/child-capacity-error.mjs';

test('known codes produce fixed safe labels without raw exception data',()=>{
 for(const code of ['REVIEW_SUBAGENTS_UNAVAILABLE','INVALID_WHOLE_SCOPE_PLAN','WHOLE_SCOPE_INPUT_BUDGET','WHOLE_SCOPE_MODEL_CALL_LIMIT','PREVIEW_EXPIRED','REVIEW_CHILD_IDENTITY']){
  const error=Object.assign(new Error('PRIVATE_SOURCE'),{code,stack:'PRIVATE_STACK',name:'PRIVATE_NAME',label:'PRIVATE_LABEL'});
  const value=safeReviewFailure(error);
  assert.equal(value.code,code);assert.equal(typeof value.label,'string');
  assert.doesNotMatch(JSON.stringify(value),/PRIVATE/);assert.deepEqual(Object.keys(value),['code','label']);
  assert.equal(Object.isFrozen(value),true);
 }
});

test('unknown malformed and hostile exceptions use fixed fallback, not message inference',()=>{
 for(const error of [null,undefined,'WHOLE_SCOPE_INPUT_BUDGET',42,{},new Error('REVIEW_SUBAGENTS_UNAVAILABLE PRIVATE'),{code:'PRIVATE_CODE',message:'PRIVATE'},{code:'__proto__'},{code:'constructor'},{code:123}]){
  const value=safeReviewFailure(error);assert.equal(value.code,'UNKNOWN_REVIEW_FAILURE');assert.doesNotMatch(JSON.stringify(value),/PRIVATE/);
 }
});

test('capacity metadata accepts only positive safe integer data fields',()=>{
 const error=new ChildInputCapacityError(900,512,{unsent:true});
 assert.deepEqual(safeReviewFailure(error),{code:'WHOLE_SCOPE_INPUT_BUDGET',label:'子会话输入超过批准容量，审核未完成。',requiredBytes:900,approvedCap:512});
 for(const value of [0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'900',null,{},true]){
  const result=safeReviewFailure({code:'WHOLE_SCOPE_INPUT_BUDGET',requiredBytes:value,approvedCap:value});
  assert.deepEqual(Object.keys(result),['code','label']);
 }
 assert.equal(safeReviewFailure({code:'WHOLE_SCOPE_INPUT_BUDGET',requiredBytes:1,approvedCap:Number.MAX_SAFE_INTEGER}).requiredBytes,1);
 assert.deepEqual(Object.keys(safeReviewFailure({code:'REVIEW_SUBAGENTS_UNAVAILABLE',requiredBytes:900,approvedCap:512})),['code','label']);
});

test('getters inherited properties and throwing reflection do not execute source accessors',()=>{
 let called=0;const error={};Object.defineProperty(error,'code',{get(){called++;throw Error('PRIVATE');}});
 assert.equal(safeReviewFailure(error).code,'UNKNOWN_REVIEW_FAILURE');assert.equal(called,0);
 const capacity={code:'WHOLE_SCOPE_INPUT_BUDGET'};for(const key of ['requiredBytes','approvedCap'])Object.defineProperty(capacity,key,{get(){called++;return 900;}});
 assert.deepEqual(Object.keys(safeReviewFailure(capacity)),['code','label']);assert.equal(called,0);
 assert.equal(safeReviewFailure(Object.create({code:'REVIEW_SUBAGENTS_UNAVAILABLE'})).code,'UNKNOWN_REVIEW_FAILURE');
 const proxy=new Proxy({},{getOwnPropertyDescriptor(){throw Error('PRIVATE');}});assert.equal(safeReviewFailure(proxy).code,'UNKNOWN_REVIEW_FAILURE');
});

test('plain code only selects presentation, does not copy approval or replay metadata',()=>{
 const input={code:'WHOLE_SCOPE_INPUT_BUDGET',requiredBytes:900,approvedCap:512,unsent:true,approved:true,modelSent:false,source:'PRIVATE'};
 const before=structuredClone(input),result=safeReviewFailure(input);
 assert.deepEqual(Object.keys(result),['code','label','requiredBytes','approvedCap']);
 assert.deepEqual(input,before);assert.equal('unsent' in result,false);assert.equal('approved' in result,false);
});
