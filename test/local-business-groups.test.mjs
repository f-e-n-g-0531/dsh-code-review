import test from 'node:test';
import assert from 'node:assert/strict';
import {localBusinessGroups} from '../src/business-groups.mjs';
import {reviewSnapshot,REVIEW_INSTRUCTIONS} from '../src/review.mjs';
import {buildCoveragePlan} from '../src/coverage-plan.mjs';
import {createRetrievalScope} from '../src/retrieval-scope.mjs';
const files=(n,lines=1)=>Array.from({length:n},(_,i)=>({id:'f'+i,path:'f'+i+'.cpp',eligibility:'reviewable',properties:[],left:{text:'old\n'.repeat(lines)},right:{text:'new\n'.repeat(lines)}}));
test('local partition uses strict four-file and 200-line boundaries and excludes forbidden members',()=>{
 assert.equal(localBusinessGroups(files(1)),null);assert.equal(localBusinessGroups(files(4)),null);assert.equal(localBusinessGroups(files(2,49)).strategy,'local-bundle');assert.equal(localBusinessGroups(files(2,50)).strategy,'local-per-file');assert.equal(localBusinessGroups([...files(3),{id:'x',eligibility:'excluded'}]).groups[0].fileIds.length,3);
});
test('unknown exact churn stays per-file and unchanged members cannot invent an interaction review',async()=>{
 const limited=localBusinessGroups(files(2,500));assert.equal(limited.churn,null);assert.equal(limited.strategy,'local-per-file');
 const selected=files(2);selected[1].right.text=selected[1].left.text;const s={id:'s',vcs:'git',context:[],files:selected};
 const p=buildCoveragePlan(s,{instructions:REVIEW_INSTRUCTIONS,scope:createRetrievalScope(s),maxInputBytes:96000,enableBusinessGrouping:true});const r=await reviewSnapshot(s,()=>({findings:[],limitations:[]}),{enableRetrieval:true,enableBusinessGrouping:true});
 assert.equal(p.interactions[0].status,'not-applicable');assert.equal(p.interactions[0].minimumCalls,0);assert.equal(r.interactions.length,0);assert.equal(r.modelCalls,2);assert.equal(r.businessGrouping.churn,2);
});
test('local bundle overflow is disclosed without expanding inputs or inventing combined coverage',async()=>{
 const s={id:'s',vcs:'git',context:[{path:'helper.cpp',text:'context();\n'.repeat(7000)}],files:files(2)};
 const p=buildCoveragePlan(s,{instructions:REVIEW_INSTRUCTIONS,scope:createRetrievalScope(s),maxInputBytes:12000,enableBusinessGrouping:true});
 const r=await reviewSnapshot(s,()=>({findings:[],limitations:[]}),{enableRetrieval:true,enableBusinessGrouping:true,maxInputBytes:12000});
 assert.equal(p.businessGrouping.minimumCalls,0);assert.equal(p.interactions[0].status,'blocked');assert.equal(p.interactions[0].minimumCalls,0);assert.equal(r.interactions[0].status,'blocked');assert.equal(r.status,'partial');assert.equal(r.coverage.completed,2);assert.equal(r.modelCalls,2);assert.equal(r.retrievalUsage.calls,0);assert.ok(r.limitations.some(l=>l.text.includes('跨文件综合未完成')));
});
test('local bundle preview execute parity skips grouping call but preserves primary and interaction review',async()=>{
 const s={id:'s',vcs:'git',context:[],files:files(3)};const p=buildCoveragePlan(s,{instructions:REVIEW_INSTRUCTIONS,scope:createRetrievalScope(s),maxInputBytes:96000,enableBusinessGrouping:true});
 const r=await reviewSnapshot(s,req=>{assert.ok(!req.instructions.includes('按共同业务契约'));return {findings:[],limitations:[]};},{enableRetrieval:true,enableBusinessGrouping:true});
 assert.equal(p.minimumCalls,4);assert.equal(r.modelCalls,4);assert.equal(r.businessGrouping.status,'skipped');assert.equal(r.coverage.completed,3);assert.equal(r.interactions[0].status,'completed');assert.equal(r.status,'completed');
});
