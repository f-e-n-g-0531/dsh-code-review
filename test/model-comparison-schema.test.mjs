import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModelComparisonSchema } from '../src/model-comparison-schema.mjs';
import { childOutputSchema } from '../src/child-output-schema.mjs';

test('comparison schema has only exact new protocol fields and optional newDelegate',()=>{
 const s=buildModelComparisonSchema();assert.equal(s.type,'object');assert.equal(s.additionalProperties,false);
 assert.deepEqual(s.required,['classification','reason','comparison']);assert.deepEqual(Object.keys(s.properties),s.required);
 assert.deepEqual(s.properties.classification.enum,['introduced','preexisting','uncertain']);
 const c=s.properties.comparison;assert.equal(c.additionalProperties,false);assert.deepEqual(c.required,['kind','roles','relationshipReason']);assert.equal(c.properties.kind.const,'model-assessed-cross-file');
 const roles=c.properties.roles;assert.equal(roles.additionalProperties,false);assert.deepEqual(Object.keys(roles.properties),['oldEntry','oldDelegate','newEntry','newDelegate','callers']);assert.deepEqual(roles.required,['oldEntry','oldDelegate','newEntry','callers']);
});

test('native role indices and explanations carry bounded validator contract',()=>{
 const s=buildModelComparisonSchema(),c=s.properties.comparison;
 for(const role of Object.values(c.properties.roles.properties)){
  assert.equal(role.type,'array');assert.equal(role.minItems,1);assert.equal(role.maxItems,8);assert.deepEqual(role.items,{type:'integer',minimum:0,maximum:7});assert.match(role.description,/distinct/);assert.match(role.description,/No duplicates/);assert.equal(Object.hasOwn(role,'uniqueItems'),false);
 }
 for(const field of [s.properties.reason,c.properties.relationshipReason]){assert.equal(field.type,'string');assert.equal(field.minLength,1);assert.equal(field.maxLength,8000);}
});

test('finite child adapter strips bounds without losing exact fields and relation disclaimer',()=>{
 const original=buildModelComparisonSchema(),before=structuredClone(original),child=childOutputSchema(original);
 assert.deepEqual(original,before);assert.equal(child.additionalProperties,false);assert.deepEqual(child.required,before.required);
 const roles=child.properties.comparison.properties.roles;assert.equal(roles.additionalProperties,false);
 assert.equal(roles.properties.oldEntry.items.type,'integer');assert.equal(roles.properties.oldEntry.items.minimum,undefined);assert.equal(roles.properties.oldEntry.minItems,undefined);assert.match(roles.properties.oldEntry.description,/0..7/);
 assert.equal(child.properties.reason.maxLength,undefined);assert.match(child.properties.reason.description,/8000/);
 assert.equal(child.properties.comparison.properties.kind.const,'model-assessed-cross-file');
 assert.match(child.properties.comparison.properties.relationshipReason.description,/no host-contract/);
});

test('schema contains no source authority legacy comparison or execution properties',()=>{
 const s=buildModelComparisonSchema();const keys=[];const visit=value=>{if(!value||typeof value!=='object')return;for(const [key,item]of Object.entries(value)){keys.push(key);visit(item);}};visit(s);
 for(const name of ['oldEvidence','newEvidence','migrationContractId','sourceId','snapshotId','path','requests','tools','receiptId','approved','causality','status'])assert.equal(keys.includes(name),false,name);
 assert.match(s.properties.classification.description,/not host-proven/);
});

test('separate schema calls never share mutable role or enum state',()=>{
 const first=buildModelComparisonSchema(),second=buildModelComparisonSchema();first.properties.classification.enum.push('forged');first.properties.comparison.properties.roles.properties.oldEntry.items.maximum=99;first.required.pop();
 assert.deepEqual(second,buildModelComparisonSchema());assert.equal(second.properties.classification.enum.includes('forged'),false);assert.equal(second.properties.comparison.properties.roles.properties.oldEntry.items.maximum,7);
});
