import test from 'node:test';
import assert from 'node:assert/strict';
import { childOutputSchema } from '../src/child-output-schema.mjs';
import { modelResultTools } from '../src/model-tools.mjs';
test('host schema subset strips only known unsupported bounds without altering field identities',()=>{const schema=modelResultTools(JSON.stringify({sourceMode:'group-primary',reviews:[]}), '')[0].parameters;const original=structuredClone(schema);const result=childOutputSchema(schema);assert.deepEqual(schema,original);assert.equal(result.type,'object');assert.ok(Array.isArray(result.oneOf));const encoded=JSON.stringify(result);assert.ok(!encoded.includes('minimum'));assert.ok(!encoded.includes('maxLength'));assert.ok(encoded.includes('fileId'));assert.ok(encoded.includes('snippet'));assert.ok(encoded.includes('required'));assert.equal(result.oneOf[0].properties.reviews.items.properties.findings.items.properties.severity.type,'string');});
test('unexpected constraints fail closed instead of silently weakening a new schema',()=>{assert.throws(()=>childOutputSchema({type:'object',not:{}}),/Unknown/);for(const bad of [null,[],true])assert.throws(()=>childOutputSchema(bad),/Invalid/);});
