import test from 'node:test';
import assert from 'node:assert/strict';
import { cppCallSites } from '../src/cpp-call-sites.mjs';
const nl=String.fromCharCode(10);
test('zero argument thread debugger allocator calls retain exact positions without binding claims',()=>{
 const calls=cppCallSites(['worker.join();','debugger->Close();','Allocator::Shutdown();'].join(nl));
 assert.deepEqual(calls.map(c=>c.expression),['worker.join','debugger->Close','Allocator::Shutdown']);assert.deepEqual(calls.map(c=>c.line),[1,2,3]);assert.ok(calls.every(c=>c.confidence==='syntax-only-unresolved'));
});
test('macros conditionals complex calls and comment contents never become claims',()=>{
 for(const text of ['#define STOP() close()'+nl+'STOP();','#ifdef X'+nl+'worker.join();','/*'+nl+'worker.join();','const char* value = "worker.join();";','worker.join(argument);'])assert.deepEqual(cppCallSites(text),[]);
 assert.equal(cppCallSites(Array(30).fill('worker.join();').join(nl)).length,20);
});
