import test from 'node:test';
import assert from 'node:assert/strict';
import {verificationLoop} from '../src/verification-loop.mjs';
import {createRetrievalScope} from '../src/retrieval-scope.mjs';
test('verification distinguishes missing evidence for one trigger variant without rewriting the candidate',async()=>{
 const candidate={fileId:'f',title:'Rejected operation mutates pending state',trigger:'invalid identifier',anchor:{kind:'line',side:'new',start:1,end:1,snippet:'update();'}};
 const before=structuredClone(candidate);const scope=createRetrievalScope({id:'s',files:[{id:'f',path:'a.js',eligibility:'reviewable',properties:[],left:{text:'validate();'},right:{text:'update();'}}],context:[]});let calls=0;
 const result=await verificationLoop(request=>{calls++;const p=JSON.parse(request.input);assert.deepEqual(p.candidates[0].finding,before);assert.match(request.instructions,/这一输入变体还是整个缺陷机制/);assert.match(request.instructions,/候选原本涵盖/);assert.match(request.instructions,/不得由宿主改写候选/);assert.match(request.instructions,/未知下游后果/);for(const answer of ['m_dwLife','PreloadRolePart','r7364'])assert.ok(!request.instructions.includes(answer));return{verdicts:[{candidateId:'c1',verdict:'uncertain',reason:'Relevant contract is not captured',evidence:[]}]};},{input:JSON.stringify({snapshotId:'s'}),instructions:'review'},[candidate],scope,{maxRounds:0,maxInputBytes:98304});
 assert.equal(calls,1);assert.deepEqual(candidate,before);assert.equal(result[0].verdict,'uncertain');
});
