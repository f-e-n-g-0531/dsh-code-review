import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRiskPlan} from '../src/risk-plan.mjs';
const files=[{fileId:'a',edits:[{id:'e1'}]},{fileId:'b',edits:[{id:'e1'}]}], catalog=[{id:'s1'}];
const risk=()=>({id:'r1',fileIds:['a','b'],editRefs:[{fileId:'a',editId:'e1'}],question:'Does release await completion?',trigger:'worker active',impact:'dangling state',checks:['Find join and remaining readers'],sourceIds:['s1']});
test('plans preserve hypotheses and qualified edits without mutating input or granting reads',()=>{const input={risks:[risk()]},before=structuredClone(input);const out=validateRiskPlan(input,files,catalog);assert.equal(out[0].status,'hypothesis');assert.equal(out[0].causality,'unverified');assert.deepEqual(input,before);assert.deepEqual(validateRiskPlan({risks:[]},files,catalog),[]);});
test('unknown excluded sources forged edits duplicate ids and oversized groups reject',()=>{
 for(const patch of [{fileIds:['foreign']},{sourceIds:['outside']},{editRefs:[{fileId:'a',editId:'e2'}]},{fileIds:['a','a']},{checks:[]},{tool:'shell'},{editRefs:[{fileId:'b',editId:'e1'}],fileIds:['a']}])assert.throws(()=>validateRiskPlan({risks:[{...risk(),...patch}]},files,catalog));
 assert.throws(()=>validateRiskPlan({risks:[risk(),risk()]},files,catalog));assert.throws(()=>validateRiskPlan({risks:Array(21).fill(risk())},files,catalog));
});
