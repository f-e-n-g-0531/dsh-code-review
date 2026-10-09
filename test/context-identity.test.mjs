import test from 'node:test';
import assert from 'node:assert/strict';
import {hash} from '../src/content.mjs';
import {contextSources} from '../src/context-identity.mjs';
const history={base:'a'.repeat(40),target:'b'.repeat(40)};
const old=()=>({path:'lib/old.ts',oldOnly:true,oldText:'baseline definition',oldRevision:history.base,oldBlobOid:'c'.repeat(40),oldHash:hash('baseline definition')});
test('old-only context has precisely one immutable baseline source and no target placeholder',()=>{
 const item=old(),sources=contextSources(item,history);
 assert.deepEqual(sources.map(s=>s.side),['context-old']);
 assert.equal(sources[0].revision,history.base);
 item.oldText='changed';assert.equal(sources[0].text,'baseline definition');
 assert.throws(()=>contextSources(item,history),/provenance/);
});
test('old-only rejects forged provenance root baseline current fields unsafe paths and invalid markers',()=>{
 for(const changes of [{text:''},{revision:history.target},{hash:'x'},{oldHash:'bad'},{oldBlobOid:'wrong'},{oldRevision:history.target},{oldOnly:false}])assert.throws(()=>contextSources({...old(),...changes},history));
 for(const h of [undefined,{...history,base:null},{...history,base:'invalid'}])assert.throws(()=>contextSources(old(),h),/provenance/);
 for(const path of ['../escape.ts','.env','lib/.ssh/key.ts'])assert.throws(()=>contextSources({...old(),path},history));
});
test('existing current and paired historical context identities remain explicit and do not synthesize old text',()=>{
 assert.deepEqual(contextSources({path:'lib/a.ts',text:''}).map(s=>s.side),['context']);
 const both={path:'lib/a.ts',text:'new',oldText:'old',revision:history.target,oldRevision:history.base};
 assert.deepEqual(contextSources(both,history).map(s=>s.side),['context','context-old']);
 assert.throws(()=>contextSources(both),/provenance/);
});
