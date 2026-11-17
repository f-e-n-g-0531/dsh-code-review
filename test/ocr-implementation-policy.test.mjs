import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewService } from '../src/service.mjs';
const source={id:'policy',vcs:'git',root:'/repo',context:[],files:[{id:'a',path:'a.js',eligibility:'reviewable',properties:[],left:{text:'old();\n'},right:{text:'new();\n'}}]};
const execution=()=>({agent:{session:{header:{id:'policy-owner',cwd:'/repo'}},options:{provider:'test',model:'fixture'}},signal:new AbortController().signal});
const flags={enableMemberIsolation:true,relationAwareGrouping:true,primaryInputMode:'focused',enableInvestigationState:true,enableAsyncVerification:true,verificationConcurrency:2};
test('new policies are host configured, disclosed, and cannot be overridden by preview arguments',async t=>{
 const service=createReviewService({async *stream(){assert.fail('preview sends no source');}},{...flags,capture:async()=>structuredClone(source)});t.after(()=>service.dispose());
 const e=execution(),p=await service.preview({},e);for(const [key,value]of Object.entries(flags))assert.equal(p.execution[key],value);
 for(const key of Object.keys(flags))await assert.rejects(service.preview({[key]:flags[key]},e),/Unknown preview/);
});
test('new policy types fail closed before capture',async()=>{
 for(const options of [{enableMemberIsolation:'true'},{relationAwareGrouping:1},{primaryInputMode:'unsafe'},{enableInvestigationState:{}},{enableAsyncVerification:null},{verificationConcurrency:5}]){
  const service=createReviewService({stream(){}},{...options,capture:async()=>{assert.fail('invalid configuration must not capture');}});
  await assert.rejects(service.preview({},execution()));service.dispose();
 }
});
