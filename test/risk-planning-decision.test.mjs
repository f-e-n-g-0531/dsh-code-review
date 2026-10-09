import test from 'node:test';
import assert from 'node:assert/strict';
import {riskPlanningDecision} from '../src/risk-plan.mjs';
const file=n=>({left:{text:''},right:{text:'changed\n'.repeat(n)}});
test('planning threshold gates exact full-file churn at inclusive 50 and group 100 boundaries',()=>{
 assert.equal(riskPlanningDecision([file(49)]).required,false);assert.equal(riskPlanningDecision([file(50)]).reason,'file-threshold');assert.equal(riskPlanningDecision([file(33),file(33),file(33)]).required,false);assert.equal(riskPlanningDecision([file(34),file(33),file(33)]).reason,'group-threshold');
});
test('unknown churn cannot skip planning and missing sources fail closed',()=>{
 const decision=riskPlanningDecision([{left:{text:'old\n'.repeat(500)},right:{text:'new\n'.repeat(500)}}]);assert.equal(decision.required,true);assert.equal(decision.reason,'unknown-churn');assert.equal(decision.totalChanged,null);assert.throws(()=>riskPlanningDecision([]));assert.throws(()=>riskPlanningDecision([{}]));
});
