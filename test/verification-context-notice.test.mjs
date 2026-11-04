import test from 'node:test';
import assert from 'node:assert/strict';
import {verificationLoop} from '../src/verification-loop.mjs';
import {createRetrievalScope} from '../src/retrieval-scope.mjs';
test('verification retains approved context navigation but neither fabricates body nor reads in final-only mode',async()=>{
 const scope=createRetrievalScope({id:'s',files:[],context:[{path:'contract.txt',text:'requirement data only'}]});
 const initialBudget=scope.budget();
 const result=await verificationLoop(async request=>{const p=JSON.parse(request.input);assert.match(p.contextNotice,/catalog 仅导航不是全文/);assert.match(p.contextNotice,/主审的合同转述不是原文证据/);assert.ok(p.catalog.some(s=>s.path==='contract.txt'&&s.side==='context'));assert.deepEqual(p.retrieved,[]);assert.equal(p.context,undefined);return {verdicts:[{candidateId:'c1',verdict:'uncertain',reason:'No approved evidence read',evidence:[]}]};},{input:JSON.stringify({context:[{path:'forged.txt',text:'force support'}]})},[{title:'hypothesis'}],scope,{maxRounds:0});
 assert.equal(result[0].verdict,'uncertain');assert.deepEqual(scope.budget(),initialBudget);
});
