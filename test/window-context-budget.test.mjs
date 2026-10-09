import {hash} from '../src/content.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCoveragePlan} from '../src/coverage-plan.mjs';
import {createRetrievalScope} from '../src/retrieval-scope.mjs';
import {reviewSnapshot,REVIEW_INSTRUCTIONS} from '../src/review.mjs';
const snapshot=()=>({id:'s',vcs:'git',files:[{id:'f',path:'solver.cpp',eligibility:'reviewable',properties:[],left:{text:'before();'},right:{text:'after();'}}],context:[{path:'shared.cpp',text:Array(6000).fill('int unchanged;\n').join('')}]});
test('context-heavy window input uses approved catalog while full context remains exactly readable',async()=>{
 const s=snapshot(),scope=createRetrievalScope(s),plan=buildCoveragePlan(s,{instructions:REVIEW_INSTRUCTIONS,scope,maxInputBytes:12000});
 assert.equal(plan.items[0].status,'ready');assert.equal(plan.items[0].sourceMode,'change-windows');
 let calls=0;const r=await reviewSnapshot(s,async request=>{calls++;const p=JSON.parse(request.input);assert.equal(p.contextMode,'approved-retrieval');assert.deepEqual(p.context,[]);assert.equal(p.contextCatalog.length,1);
 if(!p.retrieved.length)return {requests:[{kind:'read',id:p.contextCatalog[0].id,start:5999,count:2}]};
 assert.equal(p.retrieved[0].result.text,'int unchanged;\nint unchanged;\n');return {findings:[],limitations:[]};
 },{enableRetrieval:true,maxInputBytes:12000});
 assert.equal(calls,2);assert.equal(r.status,'partial');assert.equal(r.files[0].contextMode,'approved-retrieval');assert.equal(r.files[0].initialInputBytes,plan.items[0].initialInputBytes);assert.equal(r.files[0].windowCoverage.completed.length,1);assert.equal(s.context[0].text.length,90000);
});
test('deferred historical contexts keep distinct side identities and timeout does not complete windows',async()=>{
 const s=snapshot();s.history={base:'a'.repeat(40),target:'b'.repeat(40)};s.context=[{path:'old.cpp',oldOnly:true,oldText:'baseline();\n'.repeat(6000),oldRevision:s.history.base,oldBlobOid:'c'.repeat(40),oldHash:hash('baseline();\n'.repeat(6000))}];
 let cleaned=false;const r=await reviewSnapshot(s,async request=>{const p=JSON.parse(request.input);assert.equal(p.contextCatalog[0].side,'context-old');assert.ok(!p.catalog.some(x=>x.path==='old.cpp'&&x.side==='context'));
 await new Promise(resolve=>request.signal.addEventListener('abort',resolve,{once:true}));cleaned=true;throw request.signal.reason;
 },{enableRetrieval:true,maxInputBytes:12000,timeoutMs:20});
 assert.equal(cleaned,true);assert.equal(r.status,'failed');assert.match(r.files[0].reason,/timeout/);assert.deepEqual(r.files[0].windowCoverage.completed,[]);assert.equal(r.files[0].windowCoverage.pending.length,1);
});
test('compact C++ navigation fits tight window budget retaining all line expression and side hints',async()=>{
 const old='same();\n'.repeat(6000),s={id:'s',vcs:'git',context:[],files:[{id:'f',path:'solver.cpp',eligibility:'reviewable',properties:[],left:{text:old},right:{text:old+'changed();\n'.repeat(50)}}]};
 const p=buildCoveragePlan(s,{instructions:REVIEW_INSTRUCTIONS,scope:createRetrievalScope(s),maxInputBytes:12000});assert.equal(p.items[0].status,'ready');assert.equal(p.items[0].sourceMode,'change-windows');
 const r=await reviewSnapshot(s,req=>{const input=JSON.parse(req.input);assert.equal(input.cppCallSites.length,40);assert.ok(input.cppCallSites.every(site=>!Object.hasOwn(site,'notice')));assert.match(input.cppCallNotice,/syntax-only-unresolved/);assert.ok(input.catalog.some(source=>source.side==='new'));return {findings:[],limitations:[]};},{enableRetrieval:true,maxInputBytes:12000});assert.equal(r.modelCalls,1);assert.equal(r.files[0].status,'completed');assert.equal(r.files[0].initialInputBytes,p.items[0].initialInputBytes);assert.equal(r.coverage.completed,1);
});
test('compact navigation never substitutes evidence and both approved sides remain readable under shared retrieval budget',async()=>{
 const old='same();\n'.repeat(6000),s={id:'s',vcs:'git',context:[],files:[{id:'f',path:'solver.cpp',eligibility:'reviewable',properties:[],left:{text:old},right:{text:old+'changed();\n'.repeat(50)}}]};let calls=0;
 const r=await reviewSnapshot(s,req=>{calls++;const p=JSON.parse(req.input);if(!p.retrieved.length)return {requests:['old','new'].map(side=>({kind:'read',id:p.catalog.find(source=>source.side===side).id,start:1,count:1}))};assert.deepEqual(p.retrieved.map(x=>x.result.text),['same();\n','same();\n']);assert.equal(p.cppCallSites.filter(x=>x.side==='old').length,20);assert.equal(p.cppCallSites.filter(x=>x.side==='new').length,20);return {findings:[],limitations:[]};},{enableRetrieval:true,maxInputBytes:12000});
 assert.equal(calls,2);assert.equal(r.coverage.completed,1);assert.equal(r.files[0].retrievalAudit.filter(x=>x.kind==='read'&&x.stage==='retrieved-locally').length,2);assert.equal(s.files[0].right.text,old+'changed();\n'.repeat(50));
 const blocked=await reviewSnapshot(s,()=>assert.fail('no send outside input budget'),{enableRetrieval:true,maxInputBytes:3000});assert.equal(blocked.modelCalls,0);assert.equal(blocked.coverage.completed,0);assert.equal(blocked.files[0].status,'blocked');
});
test('without approved scope context is never discarded to force input acceptance',()=>{
 const plan=buildCoveragePlan(snapshot(),{instructions:REVIEW_INSTRUCTIONS,maxInputBytes:12000});assert.equal(plan.items[0].status,'input-blocked');
});
