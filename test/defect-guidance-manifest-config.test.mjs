import test from 'node:test';import assert from 'node:assert/strict';
import {defectGuidance} from '../src/defect-guidance.mjs';import {reviewSnapshot} from '../src/review.mjs';
test('manifest and config files resolve to a specific specialty and stay immutable',()=>{
  for(const [path,fileType,format,term] of [
    ['package.json','dependency-manifest','package_json','latest'],
    ['a/Cargo.toml','dependency-manifest','cargo_toml','edition'],
    ['pom.xml','dependency-manifest','pom_xml','SNAPSHOT'],
    ['build.gradle','dependency-manifest','build_gradle','SNAPSHOT'],
    ['composer.json','dependency-manifest','composer_json','secure-http'],
    ['.github/workflows/ci.yml','github-workflow','github_workflows','pull_request_target'],
    ['.github/foo.yml',undefined,'github_config','dropdown'],
    ['a.yaml',undefined,'yaml','YAML keys'],
    ['a.properties',undefined,'properties','duplicate keys'],
    ['a.json',undefined,'json','JSON keys']
  ]){
    const g=defectGuidance(path);
    assert.equal(g.fileType,fileType,path);
    assert.equal(g.format,format,path);
    assert.ok(g.checks.join(' ').includes(term),path+' '+term);
    const before=g.checks.length;g.checks.push('MUTATED');assert.equal(defectGuidance(path).checks.length,before,path);
  }
  assert.equal(defectGuidance('a/package.json.backup').format,undefined);
  assert.equal(defectGuidance('a/Cargo.toml.backup').fileType,undefined);
});
test('generic configuration keeps its language without a manifest specialty',()=>{
  for(const p of ['a.toml','a.ini','data.xml']){const g=defectGuidance(p);assert.equal(g.language,'configuration',p);assert.equal(g.format,undefined,p);}
  assert.equal(defectGuidance('a.yaml').language,'configuration');
  assert.equal(defectGuidance('a.unknown').language,'generic');
});
test('manifest format metadata reaches primary input without extra reads',async()=>{
  let calls=0;
  const r=await reviewSnapshot({id:'s',vcs:'git',context:[],files:[{id:'f',path:'package.json',eligibility:'reviewable',properties:[],left:{text:'{"dependencies":{}}'},right:{text:'{"dependencies":{"x":"latest"}}'}}]},async request=>{calls++;const g=JSON.parse(request.input).defectGuidance;assert.equal(g.format,'package_json');assert.equal(g.language,'configuration');return {findings:[],limitations:[]};});
  assert.equal(r.status,'completed');assert.equal(calls,1);
});