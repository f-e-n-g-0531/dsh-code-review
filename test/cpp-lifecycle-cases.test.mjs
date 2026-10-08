import test from 'node:test';
import assert from 'node:assert/strict';
import { cppLifecycleCases } from './fixtures/cpp-lifecycle-cases.mjs';
// An explicit abstract test contract, not execution/compilation of C++ source.
function violatesContract(text) {
 const statements=text.split(String.fromCharCode(10)); const joined=statements.indexOf('worker.join();');
 return statements.some((line,index)=>['ReleaseState();','debugger->Close();','Allocator::Shutdown();'].includes(line)&&index<joined);
}
test('three fixed lifecycle contracts distinguish early teardown from safe order',()=>{
 assert.equal(cppLifecycleCases.length,3);
 for(const c of cppLifecycleCases){assert.equal(violatesContract(c.old),false);assert.equal(violatesContract(c.defect),true);assert.equal(violatesContract(c.safe),false);}
});
