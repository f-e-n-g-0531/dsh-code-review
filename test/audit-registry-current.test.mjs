import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {waitForRegistry} from '../scripts/registry-wait.mjs';
const bytes=Buffer.from('release'),integrity='sha512-'+createHash('sha512').update(bytes).digest('base64');
const metadata=()=>new Response(JSON.stringify({dist:{integrity,tarball:'https://registry.npmjs.org/pkg/-/pkg.tgz'}}));
test('metadata body transport failure retries with fresh signal and bounded attempts',async()=>{
 let calls=0,sleeps=0;const signals=[];
 await waitForRegistry('metadata',integrity,{attempts:2,delayMs:0,fetchImpl:async(u,o)=>{signals.push(o.signal);if(++calls===1)return {ok:true,json:async()=>{throw new TypeError('body reset');}};return metadata();},sleep:async()=>sleeps++});
 assert.equal(calls,2);assert.equal(sleeps,1);assert.notEqual(signals[0],signals[1]);
});
test('metadata body exhaustion preserves last error and does not sleep after final attempt',async()=>{
 const errors=[new TypeError('first'),new DOMException('last','TimeoutError')];let calls=0,sleeps=0;
 await assert.rejects(waitForRegistry('metadata',integrity,{attempts:2,fetchImpl:async()=>({ok:true,json:async()=>{throw errors[calls++];}}),sleep:async()=>sleeps++}),e=>e===errors[1]);
 assert.equal(calls,2);assert.equal(sleeps,1);
});
test('artifact stream failure discards partial bytes and retries whole verification',async()=>{
 let calls=0,artifacts=0,sleeps=0,released=0,cancelled=0;
 await waitForRegistry('metadata',integrity,{attempts:2,delayMs:0,expectedBytes:bytes,fetchImpl:async u=>{calls++;if(u==='metadata')return metadata();if(++artifacts>1)return new Response(bytes);let reads=0;return {ok:true,body:{getReader:()=>({read:async()=>{if(++reads===1)return {done:false,value:bytes.subarray(0,3)};throw new TypeError('stream reset');},cancel:async()=>{cancelled++;throw new TypeError('cleanup reset');},releaseLock:()=>released++})}};},sleep:async()=>sleeps++});
 assert.equal(calls,4);assert.equal(sleeps,1);assert.equal(released,1);assert.equal(cancelled,1);
});
test('stream failure exhaustion retains original error and releases lock',async()=>{
 const failure=new TypeError('stream exhausted');let calls=0,sleeps=0,locks=0;
 await assert.rejects(waitForRegistry('metadata',integrity,{attempts:2,expectedBytes:bytes,fetchImpl:async u=>{calls++;if(u==='metadata')return metadata();return {ok:true,body:{getReader:()=>({read:async()=>{throw failure;},cancel:async()=>{},releaseLock:()=>locks++})}};},sleep:async()=>sleeps++}),e=>e===failure);
 assert.equal(calls,4);assert.equal(sleeps,1);assert.equal(locks,2);
});
test('invalid JSON and deterministic stream validation errors never retry',async()=>{
 await assert.rejects(waitForRegistry('metadata',integrity,{fetchImpl:async()=>new Response('bad'),sleep:()=>assert.fail('no retry')}),SyntaxError);
 await assert.rejects(waitForRegistry('metadata',integrity,{expectedBytes:bytes,fetchImpl:async u=>u==='metadata'?metadata():new Response(Buffer.alloc(bytes.length+1)),sleep:()=>assert.fail('no retry')}),/limit exceeded/);
});
