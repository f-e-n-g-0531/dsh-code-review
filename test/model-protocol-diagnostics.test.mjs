import test from 'node:test';import assert from 'node:assert/strict';
import {modelJson} from '../src/model-json.mjs';import {executeRetrievalBatch} from '../src/retrieval-protocol.mjs';import {createRetrievalScope} from '../src/retrieval-scope.mjs';import {reviewSnapshot} from '../src/review.mjs';

test('JSON diagnostics disclose output shape and size but no supplied source or repair',()=>{
 for(const [text,shape]of [['','empty'],['SECRET prose','non-json-leading'],['{"SECRET":','json-like-invalid'],['```json\n{"SECRET":','non-exact-fence']])assert.throws(()=>modelJson(text),error=>error.code==='MODEL_INVALID_JSON'&&error.message.includes('shape='+shape)&&!error.message.includes('SECRET')&&error.message.includes('no repair or retry'));
 assert.equal(modelJson('```json\n{}\n```'),'{}');
});
test('invalid read diagnostics identify fixed fields, reject whole batch and never echo values',()=>{
 for(const [change,field]of [[{start:0},'start'],[{start:'1'},'start'],[{count:201},'count'],[{count:'20'},'count'],[{path:'SECRET'},'fields'],[{id:[]},'id']]){
  const scope=createRetrievalScope({id:'s',files:[],context:[{path:'helper',text:'body'}]});
  assert.throws(()=>executeRetrievalBatch({requests:[{kind:'read',id:'s1',start:1,count:1},{kind:'read',id:'s1',start:1,count:1,...change}]},scope),error=>error.code==='MODEL_INVALID_READ_REQUEST'&&error.message.includes('index=1')&&error.message.includes(field)&&!error.message.includes('SECRET'));
  assert.equal(scope.usage().calls,0);
 }
});
test('review preserves invalid read classification and pending window coverage without retry',async()=>{
 const snapshot={id:'s',vcs:'git',context:[],files:[{id:'f',path:'a.cpp',eligibility:'reviewable',properties:[],left:{text:'old();'},right:{text:'new();'}}]};
 let calls=0;const report=await reviewSnapshot(snapshot,async()=>{calls++;return {requests:[{kind:'read',id:'s1',start:1,count:201}]};},{enableRetrieval:true});
 assert.equal(calls,1);assert.equal(report.status,'failed');assert.equal(report.files[0].failureCode,'MODEL_INVALID_READ_REQUEST');assert.equal(report.findings.length,0);assert.equal(report.coverage.completed,0);
});
