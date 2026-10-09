import test from 'node:test';
import assert from 'node:assert/strict';
import {hash} from '../src/content.mjs';
import {createRetrievalScope} from '../src/retrieval-scope.mjs';
import {inferContextRelations} from '../src/context-relations.mjs';
import {inferCsharpContext} from '../src/csharp-context.mjs';
const history={base:'a'.repeat(40),target:'b'.repeat(40)};
const old=(path,text)=>({path,oldOnly:true,oldText:text,oldRevision:history.base,oldBlobOid:'c'.repeat(40),oldHash:hash(text)});
test('reader old-only catalog has no target source and cannot restore selected excluded or deleted paths',()=>{
 const item=old('lib/a.ts','export const x=1;'),snapshot={id:'snap',history,files:[],context:[item]};
 const scope=createRetrievalScope(snapshot);assert.deepEqual(scope.catalog().map(s=>s.side),['context-old']);
 assert.equal(scope.read({id:'s1',start:1,count:1}).text,item.oldText);
 assert.throws(()=>scope.read({id:'s2',start:1,count:1}),/authorized/);
 for(const eligibility of ['excluded','blocked','reviewable'])assert.throws(()=>createRetrievalScope({...snapshot,files:[{id:'f',path:item.path,eligibility,rightExists:false,left:{text:item.oldText},right:{text:''}}]}),/conflicts/);
 assert.throws(()=>createRetrievalScope({...snapshot,context:[{...item,oldHash:'wrong'}]}),/provenance/);
});
test('relative import old-only navigation never supplies a new-side relation',()=>{
 const text="import {x} from './dep';\nx();",file={id:'f',path:'src/a.ts',eligibility:'reviewable',left:{text},right:{text}};
 const relations=inferContextRelations({history,files:[file],context:[old('src/dep.ts','export const x=1;')]},file);
 assert.ok(relations.length>0);assert.ok(relations.every(r=>r.contextSide==='old'&&r.contextVersion===history.base));
});
test('Csharp old-only definition is available only to old syntax hints',()=>{
 const text='namespace Demo;\nOld.Run();',file={id:'f',path:'src/a.cs',eligibility:'reviewable',left:{text},right:{text}};
 const definition='namespace Demo;\npublic static class Old\n{\npublic static void Run()\n{\n}\n}';
 const hints=inferCsharpContext({history,files:[file],context:[old('src/Old.cs',definition)]},file);
 assert.equal(hints.length,1);assert.equal(hints[0].contextSide,'old');assert.equal(hints[0].contextVersion,history.base);
});
