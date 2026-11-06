import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMigrationContracts } from '../src/migration-contracts.mjs';
import { prepareWholeScope } from '../src/whole-scope-plan.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { configureWireBudget } from '../src/model-wire-budget.mjs';
import { initialInputBudget } from '../src/input-budget.mjs';
const method=(name,body)=>'bool Reader::'+name+'()\n{\n'+body+'\n}\n';
const file=(id,path,old,current)=>({id,path,eligibility:'reviewable',properties:[],left:{text:old},right:{text:current}});
const snapshot=()=>({id:'route-plan-generic',vcs:'git',root:'/repo',context:[],files:[file('old','old.cpp','#if OLD\n'+method('PublicRead','    if (ready) ReadState();')+method('ReadState','    return true;'),'null;\n'),file('new','new.cpp','','#if NEW\n'+method('NewRead','    state = 1;\n    ReadState();'))]});
function setup(){const source=snapshot(),scope=configureWireBudget(createRetrievalScope(source),{nativeOutputTools:true});return{source,scope,options:{instructions:'Review exact sources',scope,maxRetrievalRounds:3,enableMigrationContracts:true}};}
test('new empty-old implementation gets old public wrapper lexical navigation without fabricating a migration contract',()=>{
 const {source,options}=setup(),before=structuredClone(source);assert.equal(buildMigrationContracts(source).contracts.length,0);
 const plan=prepareWholeScope(source,options),payload=JSON.parse(plan.batches[0].payload);
 assert.equal(payload.migrationContracts,undefined);assert.ok(payload.migrationRouteHints.length);
 const hint=payload.migrationRouteHints.find(h=>h.new.symbol==='NewRead');assert.ok(hint);assert.equal(hint.new.side,'new');assert.equal(hint.new.fileId,'new');
 const old=hint.oldReferences.find(r=>r.fileId==='old'&&r.symbol==='ReadState');assert.ok(old);assert.equal(old.side,'old');
 assert.equal(source.files[1].left.text,'');assert.equal(source.files[0].left.text.split('\n')[old.line-1].trim(),'if (ready) ReadState();');
 assert.equal(hint.status,'navigation-only');assert.equal(hint.causality,'unverified');assert.equal(hint.ambiguous,true);
 assert.ok(payload.migrationRouteLimitations.some(x=>x.includes('not a migration contract')));assert.deepEqual(source,before);
});
test('route hints participate in actual payload IDs and exact budget boundary without truncating sources',()=>{
 const {source,scope,options}=setup(),plan=prepareWholeScope(source,options),batch=plan.batches[0];
 const measured=initialInputBudget({input:batch.payload,instructions:batch.instructions,maxRetrievalRounds:3,nativeOutputTools:true},scope,1000000);
 const exact=prepareWholeScope(source,{...options,maxInputBytes:measured.bytes});assert.equal(exact.batches.length,1);assert.equal(exact.batches[0].id,batch.id);
 const low=prepareWholeScope(source,{...options,maxInputBytes:measured.bytes-1});assert.ok(low.batches.length!==1||low.batches[0].fileIds.length!==2);
 for(const part of low.batches){assert.equal(initialInputBudget({input:part.payload,instructions:part.instructions,maxRetrievalRounds:3,nativeOutputTools:true},scope,measured.bytes-1).fits,true);for(const row of JSON.parse(part.payload).reviews)assert.deepEqual(row.file,source.files.find(f=>f.id===row.fileId));}
 const disabled=prepareWholeScope(source,{...options,enableMigrationContracts:false}).batches[0];assert.notEqual(disabled.id,batch.id);assert.ok(Buffer.byteLength(batch.payload)>Buffer.byteLength(disabled.payload));
});
test('disabled flags carry neither lexical hints nor contracts in primary payload',()=>{
 const {source,options}=setup();const payload=JSON.parse(prepareWholeScope(source,{...options,enableMigrationContracts:false,enableMigrationRegression:false}).batches[0].payload);
 assert.equal(payload.migrationRouteHints,undefined);assert.equal(payload.migrationRouteLimitations,undefined);assert.equal(payload.migrationContracts,undefined);
});
