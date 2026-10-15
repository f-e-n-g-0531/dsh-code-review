import test from 'node:test';import assert from 'node:assert/strict';import {effectiveMergeinfo,captureEffectiveMergeinfo} from '../src/svn-effective-mergeinfo.mjs';
// Deferred unified acceptance; not executed during implementation.
const absent=path=>({path,present:false,identity:'frozen:'+path});
const prop=(path,value)=>({path,present:true,value,identity:'frozen:'+path});
test('effective mergeinfo uses nearest explicit ancestor and drops non-inheritable ranges',()=>{
 const value=effectiveMergeinfo('lib/a.js',[absent('lib/a.js'),prop('lib','/branches/a:1-4,5*')]);assert.equal(value.origin,'lib');assert.equal(value.inherited,true);assert.deepEqual(value.sources,[{sourcePath:'/branches/a/a.js',ranges:[{start:'1',end:'4',inheritable:true}]}]);
 assert.equal(effectiveMergeinfo('lib/a.js',[prop('lib/a.js','')]).explicitEmpty,true);assert.equal(effectiveMergeinfo('lib/a.js',[absent('lib/a.js')]).status,'unknown');
 assert.equal(effectiveMergeinfo('a.js',[absent('a.js'),absent('.')]).status,'unknown');assert.equal(effectiveMergeinfo('a.js',[absent('a.js'),absent('.')],{complete:true}).sources.length,0);
});
test('effective ancestor capture propagates access failure rather than inventing absence',async()=>{await assert.rejects(captureEffectiveMergeinfo('a.js',{read:async()=>{throw new Error('permission denied');}}),/permission denied/);});
