import test from 'node:test';
import assert from 'node:assert/strict';
import { inferContextRelations } from '../src/context-relations.mjs';
import { reviewSnapshot } from '../src/review.mjs';
const primary={id:'f',path:'src/Skin.cpp',eligibility:'reviewable',properties:[],left:{text:''},right:{text:'#include "Thread.h"'+String.fromCharCode(10)+'Stop();'}};
const snapshot={id:'s',vcs:'git',files:[primary],context:[{path:'src/Thread.h',text:'void Stop();'}]};
test('C++ explicit include context retains direction line and current version without source mutation',async()=>{
 const before=structuredClone(snapshot);const edge=inferContextRelations(snapshot,primary)[0];assert.equal(edge.fromPath,primary.path);assert.equal(edge.toPath,'src/Thread.h');assert.equal(edge.line,1);assert.equal(edge.contextVersion,'approved-current-not-historical');
 const report=await reviewSnapshot(snapshot,async r=>{const p=JSON.parse(r.input);assert.equal(p.contextRelations[0].line,1);assert.match(p.cppCallNotice,/20/);assert.equal(p.cppCallSites[0].line,2);return {findings:[],limitations:[]};});assert.equal(report.status,'completed');assert.deepEqual(snapshot,before);
});
test('selected excluded header cannot reenter through explicit context and reverse direction stays context',()=>{
 assert.deepEqual(inferContextRelations({...snapshot,files:[primary,{id:'blocked',path:'src/Thread.h',eligibility:'excluded'}]},primary),[]);
 const reverse={...snapshot,context:[{path:'src/Caller.cpp',text:'#include "Skin.cpp"'}]};const edge=inferContextRelations(reverse,primary)[0];assert.equal(edge.fromPath,'src/Caller.cpp');assert.equal(edge.toPath,primary.path);assert.equal(edge.side,'context');
});
