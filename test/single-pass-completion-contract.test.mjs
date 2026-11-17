import test from 'node:test';
import assert from 'node:assert/strict';
import {modelContract} from '../src/model-contract.mjs';
import {modelResultTools,validateNativeResult} from '../src/model-tools.mjs';
const input=JSON.stringify({sourceMode:'single-pass',reviews:[{fileId:'a'}]});
const done=()=>({status:'completed',gaps:[]});
const response=()=>({reviews:[{fileId:'a',findings:[],limitations:[],completion:done(),assuranceNotes:['No runtime tests requested']}],limitations:[],completion:done(),assuranceNotes:[]});
test('single-pass contract distinguishes static completion from assurance boundaries and never permits retrieval',()=>{const text=modelContract(input);assert.match(text,/assuranceNotes/);assert.match(text,/必要/);const schema=modelResultTools(input)[0].parameters;assert.ok(schema.properties.completion);assert.equal(schema.oneOf,undefined);assert.equal(validateNativeResult(JSON.stringify(response()),input),true);});
test('contradictory completed gaps and missing explicit completion are not native complete results',()=>{const value=response();value.completion.gaps=['Unreviewed function'];assert.equal(validateNativeResult(JSON.stringify(value),input),false);delete value.completion;assert.equal(validateNativeResult(JSON.stringify(value),input),false);assert.equal(validateNativeResult(JSON.stringify({requests:[]}),input),false);});
