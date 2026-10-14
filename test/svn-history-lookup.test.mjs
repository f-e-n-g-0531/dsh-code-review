import test from 'node:test';import assert from 'node:assert/strict';import{fixedSvnLookup}from'../src/svn-history-lookup.mjs';
test('fixed parent listing proves absence without swallowing errors and retains directory competitors',async()=>{
 const calls=[];const p=fixedSvnLookup({list:async(name,rev)=>{calls.push([name,rev]);return name==='.'?[{name:'dir',kind:'dir'},{name:'dep.js',kind:'file'}]:[{name:'a.js',kind:'file'}];}});
 assert.equal(await p.lookup('missing/a.js','1'),null);assert.deepEqual(await p.lookup('dir/a.js','1'),{kind:'file'});assert.deepEqual(await p.lookup('dir','1'),{kind:'dir'});assert.equal(calls.length,2);
 await assert.rejects(fixedSvnLookup({list:async()=>{throw Error('AUTH');}}).lookup('a.js','1'),/AUTH/);
});
test('historical listing caps siblings and refuses duplicate unsafe or malformed records',async()=>{
 for(const records of [[{name:'../escape',kind:'file'}],[{name:'a',kind:'file'},{name:'a',kind:'file'}],[{name:'a',kind:'special'}]])await assert.rejects(fixedSvnLookup({list:async()=>records}).lookup('a','1'));
 await assert.rejects(fixedSvnLookup({list:async()=>[{name:'a',kind:'file'},{name:'b',kind:'file'}],maxEntries:1}).lookup('a','1'),/budget/);
});
