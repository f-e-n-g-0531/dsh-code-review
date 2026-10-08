import { reviewSnapshot, REVIEW_INSTRUCTIONS } from '../src/review.mjs';
import { buildCoveragePlan } from '../src/coverage-plan.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { inferCsharpContext as infer } from '../src/csharp-context.mjs';
const nl=String.fromCharCode(10);
const source=['namespace App;', 'Service.Stop();'].join(nl);
const target=['namespace App;', 'public static class Service', '{', 'public static void Stop()', '{', '}', '}'].join(nl);
const primary={path:'Caller.cs',left:{text:''},right:{text:source}};
const input={files:[primary],context:[{path:'Service.cs',text:target}]};
test('approved C# static call preserves original type method and call positions',()=>{
 const before=structuredClone(input);const hints=infer(input,primary);
 assert.equal(hints.length,1);assert.equal(hints[0].callLine,2);assert.equal(hints[0].typeLine,2);assert.equal(hints[0].declarationLine,4);assert.equal(hints[0].confidence,'conservative-syntax-only');assert.deepEqual(input,before);
});
test('unsupported competitors remain ambiguity blockers and approved hints reach actual primary input',async()=>{
 for(const text of [target.replace('static class','partial class'),target+nl+'// opaque', 'namespace App;'+nl+'public class Service : Base {}']) assert.deepEqual(infer({...input,context:[...input.context,{path:'Other.cs',text}]},primary),[]);
 const file={...primary,id:'f',eligibility:'reviewable',properties:[]};
 const snapshot={id:'s',vcs:'git',files:[file],context:input.context};
 const plan=buildCoveragePlan(snapshot,{instructions:REVIEW_INSTRUCTIONS,maxInputBytes:96*1024});
 const report=await reviewSnapshot(snapshot,async r=>{const p=JSON.parse(r.input);assert.equal(p.csharpContextHints[0].callLine,2);assert.equal(p.csharpContextHints[0].contextVersion,'approved-current-not-historical');return {findings:[],limitations:[]};});
 assert.equal(report.status,'completed');assert.equal(report.modelCalls,plan.minimumCalls);
 assert.deepEqual(infer({...input,files:[primary,{path:'Service.cs',eligibility:'excluded'}]},primary),[]);
});
test('overloads duplicates alias shadowing and unsupported language syntax yield no claim',()=>{
 for(const text of [target+nl+'public static void Stop(int n) {}',target.replace('static class','partial class'),target.replace('namespace App;','namespace Other;'),target+nl+'// comment'])assert.deepEqual(infer({...input,context:[{path:'Service.cs',text}]},primary),[]);
 assert.deepEqual(infer({...input,context:[...input.context,{path:'Other.cs',text:target}]},primary),[]);
 for(const text of [source+nl+'var Service = other;', 'using Service = Other;'+nl+source, source+nl+'dynamic other;'])assert.deepEqual(infer(input,{...primary,right:{text}}),[]);
 assert.deepEqual(infer({...input,files:[primary,{path:'Service.cs'}]},primary),[]);
});
