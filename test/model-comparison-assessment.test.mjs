import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validateModelComparisonAssessment as validate} from '../src/model-comparison-assessment.mjs';
const sha=t=>createHash('sha256').update(t).digest('hex');
function fixture(){
 const texts=['old gate\n','old delegate\n','new entry\n','caller\n'];
 const catalog=texts.map((t,i)=>({id:'s'+i,path:i+'.js',fileId:i===2?'primary':'f'+i,side:i<2?'old':i===2?'new':'old',lineCount:1,hash:sha(t)}));
 const evidence=texts.map((text,i)=>({snapshotId:'snap',sourceId:'s'+i,hash:sha(text),start:1,count:1,text,status:'references-validated',causality:'unverified'}));
 const value={classification:'introduced',reason:'Same rejected request changes pending state',comparison:{kind:'model-assessed-cross-file',roles:{oldEntry:[0],oldDelegate:[1],newEntry:[2],callers:[3]},relationshipReason:'Compare old public rejection gate and new entry under the same trigger'}};
 const options={enableModelComparison:true,snapshotId:'snap',candidate:{fileId:'primary',anchor:{kind:'line',side:'new',start:1,end:1},attribution:{status:'references-validated',editIds:['e1']}},changes:{status:'changed',precision:'exact',edits:[{id:'e1',old:{start:1,count:1},new:{start:1,count:1}}]}};
 return{value,evidence,catalog,options};
}
const run=f=>validate(f.value,f.evidence,f.catalog,'primary',f.options);
test('explicit optin validates complete references but never claims machine-verified relationship',()=>{
 const f=fixture(),before=structuredClone(f),r=run(f);
 assert.equal(r.status,'model-comparison-references-validated');assert.notEqual(r.status,'comparison-references-validated');assert.equal(r.relationshipStatus,'model-assessed');assert.equal(r.causality,'unverified');assert.equal(r.sourceReferencesValidated,true);
 assert.deepEqual(r.oldEvidence,[0,1,3]);assert.deepEqual(r.newEvidence,[2]);assert.equal(r.migrationContractId,undefined);assert.deepEqual(f,before);assert.ok(Object.isFrozen(r.comparison.roles.oldEntry));
});
test('all classifications retain explicit roles; shared same-side roles are permitted',()=>{
 for(const classification of ['introduced','preexisting','uncertain']){const f=fixture();f.value.classification=classification;f.value.comparison.roles.oldDelegate=[0];f.value.comparison.roles.callers=[1,3];assert.equal(run(f).classification,classification);}
});
test('primary candidate may belong to new entry or optional new delegate without requiring both',()=>{
 for(const primaryInDelegate of [false,true]){
  const f=fixture(),text='new delegate\r\n';f.catalog.push({id:'s4',path:'delegate.js',fileId:primaryInDelegate?'primary':'other',side:'new',lineCount:1,hash:sha(text)});f.evidence.push({snapshotId:'snap',sourceId:'s4',hash:sha(text),start:1,count:1,text,status:'references-validated'});f.value.comparison.roles.newDelegate=[4];
  if(primaryInDelegate)f.catalog[2].fileId='entry';
  assert.equal(run(f).status,'model-comparison-references-validated');
 }
});
test('disabled unknown fields legacy markers and redundant arrays fail closed',()=>{
 for(const change of [f=>f.options.enableModelComparison=false,f=>delete f.options.enableModelComparison,f=>f.value.migrationContractId='forged',f=>f.value.oldEvidence=[0],f=>f.value.comparison.kind='host-verified',f=>f.value.comparison.roles.extra=[0]]){const f=fixture();change(f);assert.throws(()=>run(f));}
});
test('foreign sources wrong side snapshots text hash and unvalidated refs reject',()=>{
 for(const change of [f=>f.evidence[0].sourceId='outside',f=>f.evidence[0].snapshotId='other',f=>f.evidence[0].status='untrusted',f=>f.catalog[0].side='new',f=>f.evidence[0].hash='a'.repeat(64),f=>f.evidence[0].text='changed\n',f=>{delete f.catalog[0].hash;f.evidence[0].text='changed\n';}]){const f=fixture();change(f);assert.throws(()=>run(f));}
});
test('whole-source coverage allows bounded pages but rejects gaps empty old and contradictory overlaps',()=>{
 const f=fixture(),body='line\n'.repeat(201);f.catalog[0].lineCount=201;f.catalog[0].hash=sha(body);f.evidence[0]={...f.evidence[0],hash:sha(body),text:'line\n'.repeat(200),count:200};f.evidence.push({...f.evidence[0],start:201,count:1,text:'line\n'});f.value.comparison.roles.oldEntry=[0,4];assert.equal(run(f).sourceReferencesValidated,true);
 f.value.comparison.roles.oldEntry=[0];assert.throws(()=>run(f));
 const empty=fixture();empty.catalog[0].lineCount=0;assert.throws(()=>run(empty));
 const overlap=fixture();overlap.evidence.push({...overlap.evidence[0],text:'evil\n'});overlap.value.comparison.roles.oldEntry=[0,4];assert.throws(()=>run(overlap));
});
test('candidate identity exact edit map and primary source anchor remain mandatory',()=>{
 for(const change of [f=>f.options.candidate.fileId='foreign',f=>f.options.candidate.attribution.status='missing',f=>f.options.candidate.attribution.editIds=['other'],f=>f.options.candidate.anchor.side='old',f=>f.options.candidate.anchor.start=2,f=>f.options.candidate.anchor.end=200,f=>f.options.changes.precision='limited',f=>f.catalog[2].fileId='foreign',f=>delete f.options.changes]){const f=fixture();change(f);assert.throws(()=>run(f));}
});
test('missing duplicate wrong role indices and more than eight refs do not silently truncate',()=>{
 for(const change of [f=>f.value.comparison.roles.oldEntry=[],f=>f.value.comparison.roles.oldEntry=[0,0],f=>f.value.comparison.roles.newEntry=[0],f=>f.value.comparison.roles.callers=[99],f=>delete f.value.comparison.roles.oldDelegate,f=>f.evidence.push(...Array(5).fill(f.evidence[0]))]){const f=fixture();change(f);const before=structuredClone(f.evidence);assert.throws(()=>run(f));assert.deepEqual(f.evidence,before);}
});
test('fixed typed guard diagnostics distinguish stages without echoing source or IDs',()=>{
 const cases=[
  ['structural-schema',f=>f.value.comparison.extra='PRIVATE_SOURCE'],
  ['evidence-identity',f=>f.evidence[0].sourceId='PRIVATE_SOURCE'],
  ['role-side',f=>f.value.comparison.roles.oldEntry=[2]],
  ['role-completeness',f=>f.catalog[0].lineCount=2],
  ['anchor-edit',f=>f.options.candidate.attribution.editIds=['PRIVATE_SOURCE']],
  ['context-token',f=>f.options.context={raw:'PRIVATE_SOURCE'}]
 ];
 for(const [kind,mutate] of cases){const f=fixture();mutate(f);const before=structuredClone(f);assert.throws(()=>run(f),error=>{assert.equal(error.message,'Invalid model-assessed comparison references');assert.equal(error.code,'INVALID_MODEL_COMPARISON');assert.equal(error.comparisonFailure,kind);assert.deepEqual(Object.keys(error).sort(),['code','comparisonFailure']);assert.ok(!JSON.stringify(error).includes('PRIVATE_SOURCE'));return true;});assert.deepEqual(f,before);}
});
test('local textual range incompleteness is diagnosed without truncation or context weakening',()=>{
 const f=fixture();f.catalog[0].lineCount=2;assert.throws(()=>run(f),error=>error.code==='INVALID_MODEL_COMPARISON'&&error.comparisonFailure==='role-completeness');
 const bad=fixture();Object.defineProperty(bad.options,'context',{enumerable:true,get(){throw new Error('PRIVATE_SOURCE');}});assert.throws(()=>run(bad),error=>error.comparisonFailure==='context-token'&&!String(error).includes('PRIVATE_SOURCE'));
});
test('supplemental exact counterevidence is retained without granting role coverage',()=>{const f=fixture(),body='contract line\nother contract line\n';f.catalog.push({id:'doc',path:'contract.md',side:'context',lineCount:2,hash:sha(body)});f.evidence.push({snapshotId:'snap',sourceId:'doc',hash:sha(body),start:1,count:1,text:'contract line\n',status:'references-validated'});const result=run(f);assert.deepEqual(result.oldEvidence,[0,1,3]);assert.deepEqual(result.newEvidence,[2]);assert.equal(f.evidence.length,5);for(const change of [g=>g.evidence[4].sourceId='FOREIGN',g=>g.evidence[4].snapshotId='FOREIGN',g=>g.evidence[4].hash='a'.repeat(64),g=>g.evidence[4].status='untrusted']){const g=structuredClone(f);change(g);assert.throws(()=>run(g),e=>e.code==='INVALID_MODEL_COMPARISON'&&e.comparisonFailure==='evidence-identity');}f.value.comparison.roles.newEntry=[4];assert.throws(()=>run(f),e=>e.comparisonFailure==='role-completeness');});

test('accessors proxies and custom serialization cannot enter inert schema validation',()=>{
 const f=fixture();let called=false;const hostile={...f.value,get reason(){called=true;return 'bad';}};assert.throws(()=>validate(hostile,f.evidence,f.catalog,'primary',f.options));assert.equal(called,false);
 assert.throws(()=>validate(new Proxy(f.value,{}),f.evidence,f.catalog,'primary',f.options));
 const other=fixture();other.value.comparison.toJSON=()=>{called=true;return {};};assert.throws(()=>run(other));assert.equal(called,false);
});
