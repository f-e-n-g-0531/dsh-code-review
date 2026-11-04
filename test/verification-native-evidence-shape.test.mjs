import test from 'node:test';
import assert from 'node:assert/strict';
import {modelResultTools} from '../src/model-tools.mjs';
import {modelContract} from '../src/model-contract.mjs';
test('ordinary verifier native schema describes both exact receipt and full evidence without inventing authority',()=>{
 const input=JSON.stringify({candidates:[{candidateId:'c1'}]});
 const schema=modelResultTools(input)[0].parameters.oneOf[0].properties.verdicts.items;
 assert.deepEqual(schema.properties.evidence.items.oneOf[0].required,['receiptId']);
 assert.equal(schema.properties.evidence.items.oneOf[0].additionalProperties,false);
 assert.deepEqual(schema.properties.evidence.items.oneOf[1].required,['snapshotId','sourceId','hash','start','count','text']);
 assert.deepEqual(schema.properties.regression.properties.classification.enum,['introduced','preexisting','uncertain']);
 assert.ok(!JSON.stringify(schema).includes('migrationContractId'));
 assert.ok(!modelContract(input).includes('\"verdict\":\"uncertain\"'));
 assert.match(modelContract(input),/不默认 uncertain 或空证据/);
});
