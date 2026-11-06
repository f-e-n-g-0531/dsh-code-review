import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createModelComparisonContext,modelComparisonRanges} from '../src/model-comparison-context.mjs';
import {validateModelComparisonAssessment as validate} from '../src/model-comparison-assessment.mjs';
import {createRetrievalScope} from '../src/retrieval-scope.mjs';
const sha=text=>createHash('sha256').update(text).digest('hex');
function fixture(){
 const prefix='// unrelated\r\n'.repeat(220),fn='bool Reader::Run()\r\n{\r\n    return true;\r\n}\r\n',suffix='// trailing\r\n'.repeat(20);
 const body=prefix+fn+suffix;
 const snapshot={id:'context-snapshot',context:[],files:[{id:'f',path:'reader.cpp',eligibility:'reviewable',properties:[],left:{text:body},right:{text:body.replace('return true;','return false;')}}]};
 const scope=createRetrievalScope(snapshot),catalog=scope.catalog(),old=catalog.find(s=>s.side==='old'),fresh=catalog.find(s=>s.side==='new');
 const context=createModelComparisonContext(snapshot),navigation=modelComparisonRanges(context,[old.id,fresh.id]);assert.equal(navigation.ranges.length,2);
 const evidence=[old,fresh].map(s=>{const text=s.side==='old'?snapshot.files[0].left.text:snapshot.files[0].right.text;return{snapshotId:snapshot.id,sourceId:s.id,hash:sha(text),start:221,count:4,text:text.split(/(?<=\n)/).slice(220,224).join(''),status:'references-validated'};});
 const value={classification:'introduced',reason:'Compare captured states',comparison:{kind:'model-assessed-cross-file',roles:{oldEntry:[0],oldDelegate:[0],newEntry:[1],callers:[0]},relationshipReason:'Explicit proposed route'}};
 const options={enableModelComparison:true,snapshotId:snapshot.id,context,candidate:{fileId:'f',anchor:{kind:'line',side:'new',start:223,end:223},attribution:{status:'references-validated',editIds:['e1']}},changes:{status:'changed',precision:'exact',edits:[{id:'e1',old:{start:223,count:1},new:{start:223,count:1}}]}};
 return{snapshot,catalog,context,navigation,evidence,value,options};
}
const run=f=>validate(f.value,f.evidence,f.catalog,'f',f.options);
test('approved opaque context admits complete local functions in long sources without changing source IDs',()=>{
 const f=fixture(),result=run(f);assert.equal(result.status,'model-comparison-references-validated');assert.equal(result.relationshipStatus,'model-assessed');
 assert.deepEqual(f.navigation.ranges.map(r=>r.sourceId).sort(),f.catalog.map(s=>s.id).sort());assert.equal(result.causality,'unverified');
 assert.throws(()=>run({...f,options:Object.fromEntries(Object.entries(f.options).filter(([k])=>k!=='context'))}));
});
test('forged serialized cloned contexts cannot authorize local ranges',()=>{
 const f=fixture();for(const context of [{},structuredClone(f.context),JSON.parse(JSON.stringify(f.context)),{ranges:f.navigation.ranges}])assert.throws(()=>run({...f,options:{...f.options,context}}));
 assert.throws(()=>modelComparisonRanges({},f.catalog.map(s=>s.id)));
});
test('snapshot mutation after creation does not mutate capability; same-ID changed body hash rejects',()=>{
 const f=fixture();f.snapshot.files[0].right.text='tampered';assert.equal(run(f).sourceReferencesValidated,true);
 const changed=fixture();changed.snapshot.files[0].right.text=changed.snapshot.files[0].right.text.replace('return false;','return other;');changed.options.context=createModelComparisonContext(changed.snapshot);assert.throws(()=>run(changed));
});
test('partial functions wrong whole anchor and foreign snapshot remain rejected',()=>{
 const partial=fixture();partial.evidence[1].count=3;partial.evidence[1].text=partial.evidence[1].text.split(/(?<=\n)/).slice(0,3).join('');assert.throws(()=>run(partial));
 const anchor=fixture();anchor.options.candidate.anchor={kind:'line',side:'new',start:223,end:225};assert.throws(()=>run(anchor));
 const elsewhere=fixture();elsewhere.options.candidate.anchor={kind:'line',side:'new',start:230,end:230};elsewhere.options.changes.edits[0].new={start:230,count:1};assert.throws(()=>run(elsewhere));
 const foreign=fixture();foreign.options.snapshotId='other';assert.throws(()=>run(foreign));
});
test('metadata is detached bounded navigation, not a serialized capability or source delivery',()=>{
 const f=fixture(),ids=f.catalog.map(s=>s.id),first=modelComparisonRanges(f.context,ids);first.ranges[0].start=1;
 assert.equal(modelComparisonRanges(f.context,ids).ranges[0].start,221);assert.ok(!JSON.stringify(first).includes('return false'));
 assert.throws(()=>modelComparisonRanges(f.context,['unknown']));assert.throws(()=>modelComparisonRanges(f.context,Array(17).fill('s1')));
});
