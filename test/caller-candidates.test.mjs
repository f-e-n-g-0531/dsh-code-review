import test from 'node:test';
import assert from 'node:assert/strict';
import { callerCandidates } from '../src/caller-candidates.mjs';
const file=(path,extra={})=>({path,eligibility:'reviewable',...extra});
test('reverse navigation identifies literal references not semantic calls',()=>{
 const result=callerCandidates([file('src/dep.ts')],[{path:'app/a.ts',text:"import {x as alias} from '../src/dep';\nalias();"}],['src/dep.ts']);
 assert.deepEqual(result.candidates,[{fromPath:'app/a.ts',targetPath:'src/dep.ts',reason:'literal-relative-import',confidence:'navigation-only'}]);
 assert.ok(result.probePaths.includes('src/dep.js')); assert.match(result.notice,/not function calls/);
 assert.equal(callerCandidates([file('dep.h')],[{path:'a.cpp',text:'#include "dep.h"'}],['dep.h']).candidates.length,1);
});
test('approved caller and target bodies bind call line to unique declaration without asserting reachability',()=>{
 const target=file('src/dep.ts',{right:{text:'export function x(value) {}'}});
 const scanned=[{path:'app/a.ts',text:"import { x as alias } from '../src/dep';\nalias();"}];
 const bound=callerCandidates([target],scanned,['src/dep.ts']).candidates[0];
 assert.deepEqual(bound.bindings,[{imported:'x',local:'alias',importLine:1,callLine:2,declarationLine:1,declarationKind:'function',confidence:'conservative-syntax-only'}]);
 const ambiguous=file('src/dep.ts',{right:{text:'export function x(value) {}' + String.fromCharCode(10) + 'x = other;'}});
 assert.equal(callerCandidates([ambiguous],scanned,['src/dep.ts']).candidates[0].bindings,undefined);
 const escaped=file('src/dep.ts',{right:{text:'export function x(value) {}'}});
 assert.equal(callerCandidates([escaped],[{path:'app/a.ts',text:"import { x as alias } from '../src/dep';" + String.fromCharCode(10) + 'consume(alias);'}],['src/dep.ts']).candidates[0].bindings,undefined);
 assert.match(callerCandidates([target],scanned,['src/dep.ts']).notice,/not function calls/);
});
test('all resolution competitors suppress ambiguous references including directories',()=>{
 for(const competing of ['src/dep.js','src/dep','src/dep/index.ts']) assert.equal(callerCandidates([file('src/dep.ts')],[{path:'a.ts',text:"import x from './src/dep';"}],['src/dep.ts',competing]).candidates.length,0);
});
test('excluded deleted changed old paths secrets comments and unsupported syntax never become callers',()=>{
 for(const extra of [{eligibility:'excluded'},{rightExists:false}]) assert.equal(callerCandidates([file('dep.ts',extra)],[{path:'a.ts',text:"import x from './dep.ts';"}],['dep.ts']).candidates.length,0);
 for(const text of ["// import x from './dep.ts';", "/*\nimport x from './dep.ts';\n*/", "require('./dep.ts');", String.fromCharCode(96)+"\nimport x from './dep.ts';\n"+String.fromCharCode(96)]) assert.equal(callerCandidates([file('dep.ts')],[{path:'a.ts',text}],['dep.ts']).candidates.length,0);
 for(const name of ['a.ts','old.ts','.ssh/a.ts']) assert.equal(callerCandidates([file('dep.ts'),file('a.ts',{oldPath:'old.ts'})],[{path:name,text:"import x from './dep.ts';"}],['dep.ts']).candidates.length,0);
 assert.equal(callerCandidates([file('dep.h')],[{path:'a.cpp',text:'#if X\n#include "dep.h"'}],['dep.h']).candidates.length,0);
});
test('navigation rejects bounds duplicate inputs and silent result clipping',()=>{
 assert.throws(()=>callerCandidates([],Array(129).fill({}),[]),/limit/);
 assert.throws(()=>callerCandidates([],[],['../escape']),/Unsafe/);
 const scanned=[{path:'a.ts',text:"import x from './x';"}]; assert.throws(()=>callerCandidates([],scanned.concat(scanned),[]),/Duplicate/);
 const text=Array.from({length:40},(_,i)=>"import x"+i+" from './d"+i+"';").join('\n');
 assert.throws(()=>callerCandidates([],[{path:'a.ts',text}],[]),/probe limit/);
 const names=Array.from({length:21},(_,i)=>'d'+i+'.ts');
 assert.throws(()=>callerCandidates([],[{path:'a.ts',text:names.map((n,i)=>"import x"+i+" from './"+n+"';").join('\n')}],names),/result limit/);
});
