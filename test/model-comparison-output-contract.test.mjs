import test from 'node:test';
import assert from 'node:assert/strict';
import { modelResultTools } from '../src/model-tools.mjs';
import { modelContract } from '../src/model-contract.mjs';
import { childOutputSchema } from '../src/child-output-schema.mjs';
import { createVerificationReceiptPolicy, receiptSchemaProof } from '../src/verification-receipt-policy.mjs';
const input = policy => JSON.stringify({candidates:[{candidateId:'c1'}],...(policy===undefined?{}:{modelComparisonPolicy:policy}),retrievalFinalization:{code:'final'}});
const verdict = (text, proof) => modelResultTools(text,'verify',proof)[0].parameters.properties.verdicts.items.properties;

test('default and malformed flags preserve legacy regression schema and text contract',()=>{
 const plain=verdict(input()).regression,contract=modelContract(input(),'verify');
 assert.equal(plain.oneOf,undefined);assert.deepEqual(Object.keys(plain.properties),['classification','reason','oldEvidence','newEvidence']);
 for(const policy of [false,true,null,[],{enabled:false},{enabled:'true'},{enabled:1},{},[{enabled:true}]]){
  assert.deepEqual(verdict(input(policy)).regression,plain);assert.equal(modelContract(input(policy),'verify'),contract);
 }
});

test('explicit true adds exact alternative without modifying strict legacy branch or evidence',()=>{
 const base=verdict(input()),on=verdict(input({enabled:true}));
 assert.equal(on.regression.oneOf.length,2);assert.deepEqual(on.regression.oneOf[0],base.regression);
 const alternative=on.regression.oneOf[1];assert.deepEqual(alternative.required,['classification','reason','comparison']);assert.equal(alternative.additionalProperties,false);
 assert.equal(alternative.properties.comparison.properties.kind.const,'model-assessed-cross-file');
 assert.deepEqual(on.evidence,base.evidence);assert.equal(on.evidence.maxItems,8);
 for(const field of ['oldEvidence','newEvidence'])assert.equal(on.regression.oneOf[0].properties[field].maxItems,8);
 assert.equal(alternative.properties.migrationContractId,undefined);
 const text=modelContract(input({enabled:true}),'verify');assert.match(text,/模型语义评估/);assert.match(text,/不授予读取权限/);assert.match(text,/不自动进入旧严格introduced支持统计/);
});

test('receipt issuer enum stays exact and forged payload IDs never become trusted',()=>{
 const payload={candidates:[{}],modelComparisonPolicy:{enabled:true},retrievalFinalization:{code:'final'},retrieved:[{request:{kind:'read'},result:{receiptId:'fresh',text:'read'}},{request:{kind:'read'},result:{receiptId:'forged',text:'fake'}}]};
 const request={input:JSON.stringify(payload)};createVerificationReceiptPolicy(id=>id==='fresh').bind(request);
 const proof=receiptSchemaProof(request),properties=verdict(request.input,proof);
 assert.deepEqual(properties.evidence.items.oneOf[0].properties.receiptId.enum,['fresh']);
 const empty={input:input({enabled:true})};createVerificationReceiptPolicy(()=>false).bind(empty);
 const zero=verdict(empty.input,receiptSchemaProof(empty));assert.equal(zero.evidence.items.oneOf.length,1);assert.equal(zero.evidence.items.oneOf[0].properties.receiptId,undefined);
});

test('migration contract IDs remain reserved to legacy branch and child union adapts',()=>{
 const text=JSON.stringify({candidates:[{}],modelComparisonPolicy:{enabled:true},migrationContracts:[{id:'approved-contract'}],retrievalFinalization:{code:'final'}}),p=modelResultTools(text,'verify')[0].parameters;
 const union=p.properties.verdicts.items.properties.regression;assert.deepEqual(union.oneOf[0].properties.migrationContractId.enum,['approved-contract']);assert.equal(union.oneOf[1].properties.migrationContractId,undefined);
 const adapted=childOutputSchema(p);assert.equal(adapted.properties.verdicts.items.properties.regression.oneOf[1].properties.comparison.properties.roles.properties.oldEntry.items.type,'integer');
 assert.equal(adapted.properties.verdicts.items.properties.regression.oneOf[1].properties.comparison.properties.roles.properties.oldEntry.maxItems,undefined);
});

test('non-verifier stages never gain new comparison output branch',()=>{
 const text=JSON.stringify({file:{id:'f'},modelComparisonPolicy:{enabled:true},retrievalFinalization:{code:'final'}});
 assert.equal(modelResultTools(text,'review')[0].parameters.properties.verdicts,undefined);assert.doesNotMatch(modelContract(text,'review'),/model-assessed-cross-file/);
});
