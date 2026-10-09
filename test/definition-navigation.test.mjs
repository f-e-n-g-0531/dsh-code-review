import test from 'node:test';
import assert from 'node:assert/strict';
import {createRetrievalScope} from '../src/retrieval-scope.mjs';
import {executeRetrievalBatch} from '../src/retrieval-protocol.mjs';
import {hash} from '../src/content.mjs';
const snapshot=()=>({id:'definitions',history:{base:'a'.repeat(40),target:'b'.repeat(40)},files:[{id:'f',path:'src/use.ts',eligibility:'reviewable',left:{text:'import {run as execute} from "./helper";\nexecute();'},right:{text:'import {run as execute} from "./helper";\nexecute(1);'}}],context:[{path:'src/helper.ts',text:'// function run is navigation noise\r\nexport function run(x) { return x; }\r\n',oldText:'export function run() { return 0; }\n',revision:'b'.repeat(40),oldRevision:'a'.repeat(40)},{path:'other/helper.ts',text:'export function run() { return 42; }\n'},{path:'old/helper.ts',oldOnly:true,oldText:'export function run() { return -1; }',oldRevision:'a'.repeat(40),oldBlobOid:'c'.repeat(40),oldHash:hash('export function run() { return -1; }')}]});
test('existing find search read locates exact declarations but retains same-name ambiguity and side identity',()=>{
 const scope=createRetrievalScope(snapshot());const found=scope.find({query:'helper.ts',limit:20});assert.equal(found.matches.length,4);
 const current=found.matches.filter(m=>m.side==='context');assert.equal(current.length,2);
 const search=scope.search({query:'function run',sourceIds:current.map(m=>m.sourceId),limit:20});assert.equal(search.matches.length,3);
 // Literal search deliberately includes comments; reading is required to classify.
 const reads=search.matches.map(m=>scope.read({id:m.sourceId,start:m.line,count:1}));
 assert.ok(reads[0].text.startsWith('//'));assert.equal(reads[1].text,'export function run(x) { return x; }\r\n');assert.equal(reads[2].text,'export function run() { return 42; }\n');
 assert.equal(new Set(reads.filter(r=>r.text.startsWith('export')).map(r=>r.sourceId)).size,2);
 const old=found.matches.find(m=>m.path==='old/helper.ts');assert.equal(old.side,'context-old');
 assert.equal(scope.search({query:'return -1',sourceIds:current.map(m=>m.sourceId)}).matches.length,0);
 assert.equal(scope.search({query:'execute',sourceIds:[current[0].sourceId]}).matches.length,0);
});
test('definition navigation cannot exceed approved sources or hide truncation and shared budget exhaustion',()=>{
 const scope=createRetrievalScope(snapshot(),{maxCalls:2});
 const result=scope.search({query:'function run',limit:1});assert.equal(result.truncated,true);
 scope.read({id:result.matches[0].sourceId,start:result.matches[0].line,count:1});assert.throws(()=>scope.find({query:'helper'}),/call budget/);
 const fresh=createRetrievalScope(snapshot());assert.throws(()=>executeRetrievalBatch({requests:[{kind:'search',query:'run',limit:20},{kind:'read',id:'outside',start:1,count:1}]},fresh),/authorized/);assert.equal(fresh.usage().calls,0);
 const small=createRetrievalScope(snapshot(),{maxOutputBytes:1});assert.throws(()=>small.search({query:'run'}),/output budget/);
});
