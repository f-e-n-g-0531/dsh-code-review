import test from 'node:test';
import assert from 'node:assert/strict';
import {instanceMethodBindings} from '../src/class-bindings.mjs';
import {inferImportRelations} from '../src/import-relations.mjs';
import {reviewSnapshot} from '../src/review.mjs';
const N=String.fromCharCode(10);
const svc='export class Service {'+N+'  run(value) { return value; }'+N+'}';
const call="import { Service } from './svc';"+N+'const s = new Service();'+N+'s.run(1);';
const hints=(c=call,t=svc,line=1)=>instanceMethodBindings(c.split(N),line,t);
test('unique plain instance method binds a single-use constructor call',()=>{
 const h=hints();assert.equal(h.length,1);
 assert.equal(h[0].imported,'Service');assert.equal(h[0].instance,'s');assert.equal(h[0].member,'run');assert.equal(h[0].newLine,2);assert.equal(h[0].callLine,3);
 assert.equal(h[0].methodLine,2);
 assert.equal(h[0].confidence,'instance-method-syntax-only');
});
test('empty alias imports and unsupported class shapes refuse',()=>{
 assert.equal(instanceMethodBindings("import { a, b } from './svc';".split(N),1,svc).length,0);
 assert.equal(instanceMethodBindings("import Service from './svc';"+N+'new Service();'.split(N),1,svc).length,0);
 assert.equal(hints(call,'export class Service extends Base {'+N+'  run() {}'+N+'}').length,0);
 assert.equal(hints(call,'export class Service {'+N+'  static run() {}'+N+'}').length,0);
 assert.equal(hints(call,'export class Service {'+N+'  get run() {}'+N+'}').length,0);
 assert.equal(hints(call,'export class Service {'+N+'  run = () => {};'+N+'}').length,0);
 assert.equal(hints(call,'export class Service {'+N+'  run() {}'+N+'  run() {}'+N+'}').length,0);
});
test('alias import resolves local instantiation and alias escaped same-name refuses',()=>{
 const a=instanceMethodBindings(("import { Service as Svc } from './svc';"+N+'const s = new Svc();'+N+'s.run(1);').split(N),1,svc);
 assert.equal(a.length,1);assert.equal(a[0].imported,'Service');assert.equal(a[0].local,'Svc');
 assert.equal(instanceMethodBindings(("import { Service as s } from './svc';"+N+'const s = new s();'+N+'s.run(1);').split(N),1,svc).length,0);
});
test('generic class constructor and generic defaults refuse',()=>{
 assert.equal(hints(call,'export class Service<T> {'+N+'  run() {}'+N+'}').length,0);
 assert.equal(hints(call,'export class Service {'+N+'  constructor() {}'+N+'}').length,0);
});
test('generational nested overloaded generic and computed methods refuse',()=>{
 assert.equal(hints(call,'export class Service {'+N+'  run() {}'+N+'  m() { function run() {} }'+N+'}').length,0);
 assert.equal(hints(call,'export class Service {'+N+'  run(a) {}'+N+'  run(a, b) {}'+N+'}').length,0);
 assert.equal(hints(call,'export class Service {'+N+'  run<T>(a) {}'+N+'}').length,0);
 assert.equal(hints(call,'export class Service {'+N+'  [run]() {}'+N+'}').length,0);
});
test('instance hint reaches import relations and approved context input',async()=>{
 const main={id:'m',path:'main.ts',eligibility:'reviewable',properties:[],left:{text:"import { Service } from './dep';"+N+'const s = new Service();'+N+'s.run(1);'},right:{text:"import { Service } from './dep';"+N+'const s = new Service();'+N+'s.run(2);'}};
 const edges=inferImportRelations([main,{id:'d',path:'dep.ts',eligibility:'reviewable',properties:[],left:{text:svc},right:{text:svc}}]);
 assert.ok(edges.some(e=>e.bindingHints?.some(h=>h.confidence==='instance-method-syntax-only'&&h.member==='run')));
 const s={id:'s',vcs:'git',files:[main],context:[{path:'dep.ts',text:svc}]};
 let seen=false;
 await reviewSnapshot(s,async req=>{const p=JSON.parse(req.input);const w=(p.contextRelations??[]).flatMap(e=>e.bindingHints??[]).find(h=>h.confidence==='instance-method-syntax-only');if(w){seen=true;assert.equal(w.member,'run');assert.equal(w.methodLine,2);}return {findings:[],limitations:[]};});
 assert.equal(seen,true);
});
test('shadowing mutation escapes self-calls and duplicate instantiation refuse',()=>{
 for(const extra of [N+'s.run(); s.run();', N+'consume(s);', N+'s = other;', N+'function f(s) {}', N+'const copy = s;', N+'new Service();', N+'// s.run();'])assert.equal(hints(call.replace('s.run(1);','s.run(1);')+extra).length,0,extra);
 assert.equal(hints(call,'export class Service {'+N+'  run() { this.run(); }'+N+'}').length,0);
 assert.equal(hints(call.replace('s.run(1);','s.other(1);')).length,0);
});
