import test from 'node:test';
import assert from 'node:assert/strict';
import { decode, hash } from '../src/content.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { reviewSnapshot } from '../src/review.mjs';

const bytes=Buffer.concat([Buffer.from('int x = 1; // '),Buffer.from([0xd6,0xd0,0xce,0xc4]),Buffer.from('\r\n')]);
const value=decode(bytes);
const snapshot={id:hash(bytes),vcs:'svn',context:[{path:'context.h',...decode(Buffer.from('// UTF-8 中文\r\n'))}],files:[{id:'f1',path:'legacy.cpp',eligibility:'reviewable',properties:[],left:decode(Buffer.from(bytes).map((byte,index)=>index===8?0x30:byte)),right:value,rightExists:true}]};

test('GBK approved reads and Chinese search use text identity separately from raw bytes',()=>{
  const scope=createRetrievalScope(snapshot);
  const source=scope.catalog().find(x=>x.fileId==='f1'&&x.side==='new');
  const result=scope.read({id:source.id,start:1,count:1});
  assert.equal(result.text,'int x = 1; // 中文\r\n'); assert.equal(result.hash,hash(value.text)); assert.notEqual(result.hash,value.hash);
  const matches=scope.search({query:'中文'}).matches; assert.equal(matches.length,3); assert.ok(matches.every(m=>m.line===1));
  assert.equal(value.bytes,bytes.length); assert.equal(value.encoding,'gbk');
});

test('GBK source reaches primary and independent verifier with exact receipt and CRLF text',async()=>{
  let sends=0;
  const report=await reviewSnapshot(snapshot,request=>{
    sends++; const p=JSON.parse(request.input);
    if(!p.candidates){
      assert.equal(p.file.right.encoding,'gbk'); assert.equal(p.file.right.hash,hash(bytes)); assert.equal(p.file.right.text,value.text);
      return {findings:[{fileId:'f1',severity:'high',title:'Fixture candidate',evidence:'Must independently check source',trigger:'Fixture',impact:'Fixture',suggestion:'Fixture',attribution:{editIds:['e1'],properties:[],beforeBehavior:'x is zero',afterBehavior:'x is one',reason:'Fixture edit'},anchor:{kind:'line',side:'new',start:1,end:1,snippet:'int x = 1; // 中文'}}],limitations:[]};
    }
    const record=p.retrieved.find(x=>x.result.sourceId===p.catalog.find(s=>s.fileId==='f1'&&s.side==='new').id);
    assert.ok(record); assert.equal(record.result.text,value.text);
    return {verdicts:[{candidateId:p.candidates[0].candidateId,verdict:'refuted',reason:'Fixture source counterevidence',evidence:[{receiptId:record.result.receiptId}]}]};
  },{enableRetrieval:true,enableVerification:true});
  assert.equal(report.status,'completed',JSON.stringify(report)); assert.equal(sends,2); assert.equal(report.findings[0].verification.verdict,'refuted');
  assert.equal(report.findings[0].verification.evidence[0].text,value.text); assert.equal(report.findings[0].verification.evidence[0].hash,hash(value.text));
  assert.equal(report.retrievalUsage.calls,2); assert.equal(report.files[0].retrievalAudit.length,1);
});
