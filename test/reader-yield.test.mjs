import test from 'node:test';
import assert from 'node:assert/strict';
import {createRetrievalScope} from '../src/retrieval-scope.mjs';
import {createReviewReaderAllocation} from '../src/review-reader-allocation.mjs';
const make=()=>createRetrievalScope({id:'s',context:[],files:[{id:'f',path:'f',eligibility:'reviewable',left:{text:'old\n'},right:{text:'new\n'}}]},{maxCalls:6,maxOutputBytes:20000});
const request={kind:'read',id:'s2',start:1,count:1};

test('yield waits for others unused terminal release then resumes without resetting root ledger',()=>{
 const root=make(),a=createReviewReaderAllocation(root,[{id:'a',weight:1},{id:'b',weight:1},{id:'future',weight:1}]);
 const scope=a.scope('a');scope.read(request);scope.read(request);assert.throws(()=>scope.read(request),{code:'READER_CALL_BUDGET_EXCEEDED'});
 a.yield('a');assert.throws(()=>scope.read(request),/unavailable/);assert.equal(a.resume('a',[request]).resumed,false);
 assert.equal(a.scope('future').budget().remainingCalls,2);assert.equal(root.usage().calls,2);
 a.release('b');assert.equal(a.resume('a',[request]).resumed,true);a.scope('a').read(request);a.scope('a').read(request);
 assert.equal(root.usage().calls,4);assert.equal(root.budget().remainingCalls,2);assert.equal(a.scope('future').budget().remainingCalls,2);
 a.scope('future').read(request);a.scope('future').read(request);assert.equal(root.usage().calls,6);assert.throws(()=>scope.read(request),{code:'READER_CALL_BUDGET_EXCEEDED'});
});

test('FIFO resume opportunities protect yielded peers and no progress never spins or burns polling attempts',()=>{
 const root=make(),a=createReviewReaderAllocation(root,[{id:'a',weight:1},{id:'b',weight:1},{id:'c',weight:1}]);
 a.yield('a');a.yield('b');a.release('c');assert.equal(a.resume('b',[request]).reason,'READER_RESUME_WAITING');assert.equal(a.resume('a',[request]).resumed,true);assert.equal(a.resume('b',[request]).resumed,true);
 a.yield('a');for(let i=0;i<100;i++)assert.equal(a.resume('a',[request]).reason,'READER_RESUME_WAITING');assert.equal(a.resume('a',[]).reason,'READER_RESUME_REQUESTS_REQUIRED');
 assert.equal(root.usage().calls,0);
});

test('failed eligible resumes are bounded across releases and rejected requests never spend root budget',()=>{
 const root=make(),a=createReviewReaderAllocation(root,[{id:'a',weight:1},{id:'b',weight:1},{id:'c',weight:1}]);
 a.yield('a');a.release('b');const huge=Array.from({length:7},()=>request);
 assert.equal(a.resume('a',huge).resumed,false);a.release('c');assert.equal(a.resume('a',huge).resumed,false);assert.equal(a.resume('a',[request]).reason,'READER_RESUME_ATTEMPTS_EXHAUSTED');assert.equal(root.usage().calls,0);
});

test('active transaction cannot yield or release its floor and rollback remains atomic',()=>{
 const root=make(),a=createReviewReaderAllocation(root,[{id:'a',weight:1},{id:'b',weight:1}]),scope=a.scope('a');
 assert.throws(()=>scope.transaction(()=>{scope.read(request);a.yield('a');}),/transaction active/);assert.equal(root.usage().calls,0);assert.equal(scope.usage().calls,0);
 assert.throws(()=>scope.transaction(()=>a.release('a')),/transaction active/);scope.read(request);assert.equal(root.usage().calls,1);
});

test('scalar resume admission shares FIFO gate and keeps actual reads bounded by future floors',()=>{
 const root=make(),a=createReviewReaderAllocation(root,[{id:'a',weight:1},{id:'b',weight:1},{id:'future',weight:1}]);
 const oldScope=a.scope('a');oldScope.read(request);oldScope.read(request);a.yield('a');
 assert.equal(a.resumeBudget('a').reason,'READER_RESUME_WAITING');a.release('b');assert.equal(a.resumeBudget('a').resumed,true);
 assert.equal(a.scope('a'),oldScope);oldScope.read(request);oldScope.read(request);assert.throws(()=>oldScope.read(request),{code:'READER_CALL_BUDGET_EXCEEDED'});
 assert.equal(a.scope('future').budget().remainingCalls,2);assert.equal(root.usage().calls,4);assert.equal(root.budget().maxCalls,6);
});

test('scalar admission validates minima and failed opportunities remain bounded without root spending',()=>{
 const root=make(),a=createReviewReaderAllocation(root,[{id:'a',weight:1},{id:'b',weight:1},{id:'c',weight:1}]);a.yield('a');
 for(const options of [{requiredCalls:-1},{requiredOutputBytes:Infinity},{requiredCalls:0,requiredOutputBytes:0}])assert.throws(()=>a.resumeBudget('a',options),/Invalid reader resume budget/);
 a.release('b');assert.equal(a.resumeBudget('a',{requiredCalls:7}).resumed,false);a.release('c');assert.equal(a.resumeBudget('a',{requiredOutputBytes:20001}).resumed,false);
 assert.equal(a.resumeBudget('a').reason,'READER_RESUME_ATTEMPTS_EXHAUSTED');assert.equal(root.usage().calls,0);assert.equal(root.usage().outputBytes,0);
});

test('scalar admission and exact request resume cannot bypass each other in FIFO queue',()=>{
 const root=make(),a=createReviewReaderAllocation(root,[{id:'a',weight:1},{id:'b',weight:1},{id:'c',weight:1}]);a.yield('a');a.yield('b');a.release('c');
 assert.equal(a.resumeBudget('b').reason,'READER_RESUME_WAITING');assert.equal(a.resume('a',[request]).resumed,true);assert.equal(a.resumeBudget('b').resumed,true);
 a.yield('a');assert.equal(a.resume('a',[]).reason,'READER_RESUME_REQUESTS_REQUIRED');
});
