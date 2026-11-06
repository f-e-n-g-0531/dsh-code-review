import test from 'node:test';
import assert from 'node:assert/strict';
import {modelResultTools} from '../src/model-tools.mjs';
import {childOutputSchema} from '../src/child-output-schema.mjs';
test('verification evidence schema describes mutually exclusive strict receipt and full references',()=>{
 const schema=modelResultTools(JSON.stringify({candidates:[]}))[0].parameters.oneOf[0];
 const [receipt,full]=schema.properties.verdicts.items.properties.evidence.items.oneOf;
 assert.deepEqual(Object.keys(receipt.properties),['receiptId']);
 assert.deepEqual(receipt.required,['receiptId']);assert.equal(receipt.additionalProperties,false);
 assert.match(receipt.properties.receiptId.description,/ONLY receiptId/);assert.match(receipt.description,/Do not invent/);
 assert.deepEqual(Object.keys(full.properties),['snapshotId','sourceId','hash','start','count','text']);assert.equal(full.additionalProperties,false);
 assert.match(full.description,/Do not include receiptId/);
 const adapted=childOutputSchema(schema).properties.verdicts.items.properties.evidence.items.oneOf;
 assert.equal(adapted[0].properties.receiptId.description,receipt.properties.receiptId.description);
 assert.equal(adapted[1].description,full.description);
});
