import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {waitForRegistry} from '../scripts/registry-wait.mjs';
const bytes=Buffer.from('release'),integrity='sha512-'+createHash('sha512').update(bytes).digest('base64');
const metadata=(url='https://registry.npmjs.org/pkg/-/pkg.tgz')=>new Response(JSON.stringify({dist:{integrity,tarball:url}}));
test('metadata success never bypasses tarball 404; bounded retries eventually verify actual bytes',async()=>{let calls=0,sleeps=0;await waitForRegistry('metadata',integrity,{expectedBytes:bytes,attempts:2,fetchImpl:async u=>{calls++;return u==='metadata'?metadata():calls===2?new Response('',{status:404}):new Response(bytes);},sleep:async()=>sleeps++});assert.equal(calls,4);assert.equal(sleeps,1);});
test('artifact fetch failure retries the verification attempt then checks exact bytes', async () => {
 let calls=0,sleeps=0,artifactCalls=0;
 await waitForRegistry('metadata',integrity,{expectedBytes:bytes,attempts:2,
  fetchImpl:async (url,options)=>{
   calls++;
   if(url==='metadata')return metadata();
   assert.equal(options.redirect,'error');
   if(++artifactCalls===1)throw new TypeError('fetch failed');
   return new Response(bytes);
  },sleep:async()=>sleeps++,
 });
 assert.equal(calls,4);assert.equal(artifactCalls,2);assert.equal(sleeps,1);
});
test('artifact fetch exhaustion preserves final error without final sleep', async () => {
 const failure=new DOMException('artifact timeout','TimeoutError');let calls=0,sleeps=0;
 await assert.rejects(waitForRegistry('metadata',integrity,{expectedBytes:bytes,attempts:2,
  fetchImpl:async url=>{calls++;if(url==='metadata')return metadata();throw failure;},sleep:async()=>sleeps++,
 }),error=>error===failure);
 assert.equal(calls,4);assert.equal(sleeps,1);
});
test('artifact verification failures are not retried as network errors', async () => {
 for(const response of [()=>new Response('wrong'),()=>new Response('releaseX'),()=>new Response('',{status:403})]){
  let calls=0;
  await assert.rejects(waitForRegistry('metadata',integrity,{expectedBytes:bytes,attempts:2,
   fetchImpl:async url=>{calls++;return url==='metadata'?metadata():response();},
   sleep:async()=>assert.fail('verification failures must fail immediately'),
  }));
  assert.equal(calls,2);
 }
});
test('tarball exhaustion mismatch oversize and untrusted URL fail closed',async()=>{for(const body of [new Response('',{status:404}),new Response('wrong'),new Response('releaseX')])await assert.rejects(waitForRegistry('metadata',integrity,{expectedBytes:bytes,attempts:1,fetchImpl:async u=>u==='metadata'?metadata():body}));await assert.rejects(waitForRegistry('metadata',integrity,{expectedBytes:bytes,fetchImpl:async()=>metadata('https://evil.example/package')}),/Invalid registry artifact URL/);});
