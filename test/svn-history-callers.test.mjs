import test from 'node:test';import assert from 'node:assert/strict';import {hash}from'../src/content.mjs';import{svnHistoryCallers}from'../src/svn-history-callers.mjs';
const history={base:'1',target:'2'};
const target={path:'lib/target.js',eligibility:'reviewable',oldKind:'file',newKind:'file',left:{text:'export function Old() {}\n'},right:{text:'export function New() {}\n'}};
const source=(text,revision)=>({kind:'file',content:{text,hash:hash(text),bytes:Buffer.byteLength(text),encoding:'utf-8'},source:{operativeRevision:revision}});
function caps(bodies){return {index:async(_scopes,rev)=>Object.keys(bodies[rev]).map(path=>({path,kind:'file'})),read:async(name,rev)=>source(bodies[rev][name],rev),lookup:async(name)=>name==='lib/target.js'?{kind:'file'}:null};}
test('fixed SVN callers bind old and new call hints to the correct version declarations',async()=>{
 const bodies={'1':{'clients/use.js':'import { Old } from "../lib/target.js";\nOld();\n'},'2':{'clients/use.js':'import { New } from "../lib/target.js";\nNew();\n'}};const context=[];
 const result=await svnHistoryCallers([target],history,['clients'],context,caps(bodies));
 assert.equal(context.length,1);assert.match(context[0].oldText,/Old/);assert.match(context[0].text,/New/);assert.equal(context[0].oldRevision,'1');assert.equal(context[0].revision,'2');
 assert.deepEqual(result.candidates.map(c=>[c.side,c.revision,c.bindings[0].imported]),[['old','1','Old'],['new','2','New']]);assert.equal(result.incomplete,true);
});
test('only matched SVN caller sides are captured, not the unmatched baseline or target body',async()=>{
 const bodies={'1':{'clients/use.js':'UNMATCHED OLD\n'},'2':{'clients/use.js':'import "../lib/target.js";\n'}};const context=[];
 const result=await svnHistoryCallers([target],history,['clients'],context,caps(bodies));assert.equal(result.scanned.length,2);assert.equal(context[0].oldText,undefined);assert.equal(context[0].text,bodies['2']['clients/use.js']);assert.equal(result.candidates.length,1);
});
test('caller capabilities preserve old-only constraints and exclude rules changes and credentials',async()=>{
 const bodies={'1':{'clients/use.js':'import "../lib/target.js";\n'},'2':{'clients/use.js':'import "../lib/target.js";\n'}};
 const context=[{path:'clients/use.js',oldOnly:true,oldText:bodies['1']['clients/use.js'],oldRevision:'1'}];
 const result=await svnHistoryCallers([target],history,['clients'],context,caps(bodies));assert.equal(context[0].text,undefined);assert.equal(result.candidates.find(c=>c.side==='new').status,'blocked');
 let reads=0;const options={...caps(bodies),read:async()=>{reads++;throw Error('Unexpected read');},rulePaths:['clients/use.js']};const excluded=await svnHistoryCallers([target],history,['clients'],[],options);assert.equal(reads,0);assert.equal(excluded.candidates.length,0);
 const noTarget=await svnHistoryCallers([{...target,eligibility:'excluded'}],history,['clients'],[],caps(bodies));assert.equal(noTarget.candidates.length,0);
});
test('historical callers enforce shared scans and context slots without silently clean coverage',async()=>{
 const bodies={'1':{'clients/use.js':'import "../lib/target.js";\n'},'2':{'clients/use.js':'import "../lib/target.js";\n'}};
 const limited=await svnHistoryCallers([target],history,['clients'],[{path:'reserved.js',text:'x'}],{...caps(bodies),maxContextFiles:1});assert.equal(limited.capturedPaths.length,0);assert.ok(limited.candidates.every(c=>c.status==='blocked'));
 await assert.rejects(svnHistoryCallers([target],history,['clients'],[],{...caps(bodies),read:async(_name,rev)=>({...source('x',rev),content:{text:'x',bytes:-1}})}),/size/);
 const many=Object.fromEntries(Array.from({length:129},(_,i)=>['clients/a'+i+'.js','no match']));await assert.rejects(svnHistoryCallers([target],history,['clients'],[],caps({'1':many,'2':{}})),/scan count/);
});
test('underreported raw bytes cannot bypass cumulative text scan budget',async()=>{
 const text='x'.repeat(256*1024);const entries=Array.from({length:5},(_,i)=>({path:'clients/a'+i+'.js',kind:'file'}));let reads=0;
 await assert.rejects(svnHistoryCallers([target],history,['clients'],[],{index:async()=>entries,lookup:async()=>null,read:async(_name,rev)=>{reads++;return {...source(text,rev),content:{text,bytes:0}};}}),/scan source limit/);assert.equal(reads,5);
});
test('index escapes read failures and ambiguous node competitors cannot become successful caller coverage',async()=>{
 const bodies={'1':{},'2':{'clients/use.js':'import "../lib/target";\n'}};
 await assert.rejects(svnHistoryCallers([target],history,['clients'],[],{...caps(bodies),index:async()=>[{path:'outside.js',kind:'file'}]}),/Unsafe/);
 await assert.rejects(svnHistoryCallers([target],history,['clients'],[],{...caps(bodies),read:async()=>{throw Error('AUTH');}}),/AUTH/);
 const result=await svnHistoryCallers([target],history,['clients'],[],{...caps(bodies),lookup:async name=>name==='lib/target'?{kind:'dir'}:name==='lib/target.js'?{kind:'file'}:null});assert.equal(result.candidates.length,0);
});
