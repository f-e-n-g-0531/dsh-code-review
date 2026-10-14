import test from 'node:test';import assert from 'node:assert/strict';
import {svnHistoryDependencies} from '../src/svn-history-dependencies.mjs';
const history={base:'1',target:'2'};
const main={path:'main.cpp',eligibility:'reviewable',oldKind:'file',newKind:'file',left:{text:'#include "old.h"\n'},right:{text:'#include "new.h"\n'}};
function capabilities(objects,reads=[]){return {lookup:async(name,rev)=>Object.hasOwn(objects[rev],name)?{kind:'file'}:null,read:async(name,rev)=>{reads.push([name,rev]);return {content:{text:objects[rev][name]},source:{operativeRevision:rev}};}};}
test('SVN dependency navigation keeps separate three-layer revision chains without target substitution',async()=>{
 const reads=[],context=[];const objects={'1':{'old.h':'#include "shared.h"\n','shared.h':'OLD SHARED\n'},'2':{'new.h':'#include "shared.h"\n','shared.h':'NEW SHARED\n'}};
 const result=await svnHistoryDependencies([main],history,context,capabilities(objects,reads));
 const old=context.find(c=>c.path==='old.h');assert.equal(old.oldOnly,true);assert.equal(old.text,undefined);
 const shared=context.find(c=>c.path==='shared.h');assert.equal(shared.oldText,'OLD SHARED\n');assert.equal(shared.text,'NEW SHARED\n');assert.equal(shared.oldOnly,undefined);
 assert.ok(reads.some(([name,rev])=>name==='old.h'&&rev==='1'));assert.ok(!reads.some(([name,rev])=>name==='old.h'&&rev==='2'));assert.equal(result.maxDepth,3);
});
test('SVN dependency failures propagate and excluded changes or old-only contexts cannot reenter',async()=>{
 const objects={'1':{'old.h':'OLD'},'2':{'new.h':'NEW'}};let reads=0;
 const excluded={path:'old.h',eligibility:'excluded',oldKind:'file',left:{text:'SECRET'}};
 const context=[{path:'new.h',oldOnly:true,oldText:'BASE',oldRevision:'1'}];
 const result=await svnHistoryDependencies([main,excluded],history,context,{...capabilities(objects),read:async()=>{reads++;throw Error('Unexpected read');}});
 assert.equal(reads,0);assert.equal(context[0].text,undefined);assert.ok(result.candidates.every(c=>c.sides.every(s=>s.status==='blocked')));
 await assert.rejects(svnHistoryDependencies([main],history,[],{lookup:async()=>{throw Error('AUTH FAILURE');},read:async()=>{}}),/AUTH FAILURE/);
 await assert.rejects(svnHistoryDependencies([main],history,[],{...capabilities(objects),read:async()=>{throw Error('BODY FAILURE');}}),/BODY FAILURE/);
});
test('SVN dependency rule isolation and third-layer cutoff remain explicit',async()=>{
 const onlyNew={...main,left:{text:''},right:{text:'#include "a.h"\n'}};
 const objects={'1':{},'2':{'a.h':'#include "b.h"\n','b.h':'#include "c.h"\n','c.h':'#include "d.h"\n','d.h':'TOO DEEP'}};
 const context=[],result=await svnHistoryDependencies([onlyNew],history,context,capabilities(objects));assert.equal(context.length,3);assert.equal(result.truncated,true);assert.ok(!context.some(c=>c.path==='d.h'));
 const rules=await svnHistoryDependencies([onlyNew],history,[],{...capabilities(objects),rulePaths:['a.h']});assert.equal(rules.capturedPaths.length,0);assert.match(rules.candidates[0].sides[0].reason,/Rule path/);
 const abort=new AbortController();abort.abort();await assert.rejects(svnHistoryDependencies([onlyNew],history,[],{...capabilities(objects),signal:abort.signal}));
});
test('SVN dependency context slot limit is explicit and directory resolution competitors remain ambiguous',async()=>{
 const result=await svnHistoryDependencies([main],history,[{path:'reserved.h',text:'already'}],{...capabilities({'1':{'old.h':'OLD'},'2':{'new.h':'NEW'}}),maxContextFiles:1});
 assert.equal(result.capturedPaths.length,0);assert.ok(result.candidates.every(c=>c.sides.every(s=>s.status==='blocked')));
 const js={...main,path:'main.js',left:{text:''},right:{text:'import "./dep";\n'}};
 const context=[];await svnHistoryDependencies([js],history,context,{lookup:async(name)=>name==='dep'?{kind:'dir'}:name==='dep.js'?{kind:'file'}:null,read:async()=>{throw Error('Ambiguous source read');}});assert.equal(context.length,0);
});
