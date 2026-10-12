import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceImportBindings} from '../src/namespace-bindings.mjs';
import {callerCandidates} from '../src/caller-candidates.mjs';
import {reviewSnapshot} from '../src/review.mjs';
import {preparePrimaryInput} from '../src/primary-input.mjs';
import {createRetrievalScope} from '../src/retrieval-scope.mjs';
import {prepareInteractionInput} from '../src/interaction-input.mjs';
const source="import * as api from './dep.ts';\nawait api.run(1);",target='export function run(value) { return value; }';
const hints=(text=source,body=target)=>namespaceImportBindings(text.split('\n'),1,body);
test('namespace members map calls to unique approved named declaration only',()=>{
 assert.deepEqual(hints(),[{imported:'run',local:'api',member:'run',importLine:1,callLine:2,declarationLine:1,declarationKind:'function',confidence:'namespace-member-syntax-only'}]);
 assert.equal(hints(source,'export default function run() {}').length,0);
 assert.equal(hints(source,target+'\nrun = other;').length,0);
 assert.equal(hints(source,target+'\nexport function run() {}').length,0);
 assert.equal(hints(source.replace('api','ns$').replace('api.run','ns$.run')).length,1);
});
test('namespace shadowing mutation escapes indirect calls and unsafe lexical states refuse',()=>{
 for(const suffix of ['\napi.run = replacement;','\nconsume(api);','\nfunction f(api) {}','\nconst copy = api;','\napi.run(api);','\napi["run"]();','\napi.run.bind(null)();','\napi.run(); api.run();','\n/* hidden */','\n'+String.fromCharCode(96)+'text'+String.fromCharCode(96),'\n"continued'+String.fromCharCode(92,10)+'api.run();"'])assert.equal(hints(source+suffix).length,0,suffix);
 assert.equal(hints("import type * as api from './dep.ts';\napi.run();").length,0);
 assert.equal(hints("import {api} from './dep.ts';\napi.run();").length,0);
 assert.equal(hints("import * as api from './dep.ts';\n"+Array(21).fill('api.run();').join('\n')).length,0);
 assert.equal(hints(source,'/* unsafe */'+target).length,0);
});
test('composite expressions escaped identifiers and JSX text fail closed',()=>{
 for(const call of ['api.run()();','api.run() && sideEffect();','api.run(sideEffect());','api.run('+String.fromCharCode(92)+'u0061pi.run = replacement);'])assert.equal(hints("import * as api from './dep.ts';\n"+call).length,0,call);
 assert.equal(hints("import * as api from './dep.ts';\nfunction f("+String.fromCharCode(92)+"u0061pi) {\napi.run();\n}").length,0);
 assert.equal(hints("import * as api from './dep.ts';\nconst view = <div>\napi.run();\n</div>;").length,0);
 assert.equal(hints(source,target+'\n'+String.fromCharCode(92)+'u0072un = replacement;').length,0);
});
test('interaction namespace metadata retries without dropping sources or other relations',()=>{
 const files=['a','b'].map(id=>({id,path:id+'.ts',eligibility:'reviewable',properties:[],left:{text:''},right:{text:source}}));
 const s={id:'s',vcs:'git',files,context:[{path:'dep.ts',text:target}]},group={id:'g',fileIds:['a','b']};
 const full=prepareInteractionInput(s,group,p=>({fits:true,bytes:Buffer.byteLength(p)}));
 const envelope=JSON.parse(full.payload);envelope.contextRelations.forEach(e=>e.bindingHints=[]);
 const limit=Buffer.byteLength(JSON.stringify(envelope));assert.ok(full.budget.bytes>limit);
 const retry=prepareInteractionInput(s,group,p=>({fits:Buffer.byteLength(p)<=limit,bytes:Buffer.byteLength(p)}));
 assert.equal(retry.status,'ready');assert.equal(retry.optionalBindingFallback,'input-budget');assert.equal(retry.omittedOptionalBindingCount,2);assert.equal(retry.payload,JSON.stringify(envelope));assert.equal(JSON.parse(retry.payload).context[0].text,target);
});
test('grouped namespace metadata retries before dropping related files',()=>{
 const files=[{id:'a',path:'main.ts',eligibility:'reviewable',properties:[],left:{text:source},right:{text:source+'\n// changed'}},{id:'b',path:'dep.ts',eligibility:'reviewable',properties:[],left:{text:target},right:{text:target+'\n// changed'}}];
 const s={id:'s',vcs:'git',files,context:[]},grouping={groups:[{id:'g',fileIds:['a','b']}],links:[]};
 const options=b=>({instructions:'review',scope:createRetrievalScope(s),grouping,maxInputBytes:b});
 const full=preparePrimaryInput(s,files[0],options(1<<20));assert.deepEqual(full.metadata.relatedFileIds,['b']);
 const retry=preparePrimaryInput(s,files[0],options(full.metadata.initialInputBytes-1));
 assert.deepEqual(retry.metadata.relatedFileIds,['b']);assert.equal(retry.metadata.optionalBindingFallback,'input-budget');assert.ok(retry.metadata.omittedOptionalBindingCount>0);assert.equal(retry.budget.fits,true);
 assert.ok(retry.payload.includes('"path":"dep.ts"'));assert.ok(!retry.payload.includes('namespace-member-syntax-only'));
});
test('per-import path ambiguity cannot be rescued by an explicit second namespace import',()=>{
 const f={path:'dep.ts',eligibility:'reviewable',right:{text:target}};
 const text="import * as api from './dep';\nimport { unused } from './dep.ts';\napi.run(1);";
 assert.equal(callerCandidates([f],[{path:'main.ts',text}],['dep.ts','dep.js']).candidates[0].bindings,undefined);
 assert.equal(callerCandidates([f],[{path:'main.ts',text}],['dep.ts']).candidates[0].bindings[0].member,'run');
});
test('optional namespace hints fall back without discarding approved source',()=>{
 const old=source+'\n'+Array.from({length:500},(_,i)=>'// '+i+' '+'x'.repeat(100)).join('\n');
 const f={id:'f',path:'main.ts',eligibility:'reviewable',properties:[],left:{text:old},right:{text:old+'\n// changed'}};
 const s={id:'s',vcs:'git',files:[f],context:[{path:'dep.ts',text:target}]};
 const p=preparePrimaryInput(s,f,{instructions:'review',scope:createRetrievalScope(s),maxInputBytes:12000});
 assert.equal(p.budget.fits,true);assert.equal(p.metadata.optionalBindingFallback,'input-budget');assert.ok(p.metadata.omittedOptionalBindingCount>0);
 assert.ok(JSON.parse(p.payload).contextRelations.every(e=>e.bindingHints.every(h=>h.confidence!=='namespace-member-syntax-only')));
 assert.equal(s.context[0].text,target);
});
test('namespace navigation reaches approved context and independently isolated history sides',async()=>{
 const base='a'.repeat(40),targetRevision='b'.repeat(40);
 const file={id:'f',path:'main.ts',eligibility:'reviewable',properties:[],left:{text:source},right:{text:source}};
 const s={id:'s',vcs:'git',history:{base,target:targetRevision},files:[file],context:[{path:'dep.ts',oldText:target,oldRevision:base,text:'\n\n'+target,revision:targetRevision}]};
 let calls=0;await reviewSnapshot(s,async r=>{calls++;const p=JSON.parse(r.input);const e=p.contextRelations.filter(e=>e.bindingHints?.length);assert.deepEqual(e.map(e=>[e.contextSide,e.bindingHints[0].declarationLine]),[['old',1],['new',3]]);return {findings:[],limitations:[]};});assert.equal(calls,1);
 const noOld={...s,context:s.context.map(({oldText,oldRevision,...c})=>c)};
 await reviewSnapshot(noOld,async r=>{assert.ok(JSON.parse(r.input).contextRelations.every(e=>e.contextSide==='new'));return {findings:[],limitations:[]};});
});
