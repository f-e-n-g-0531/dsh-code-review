import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMigrationContracts } from '../src/migration-contracts.mjs';
const file = (left, right='') => ({id:'p',path:'Plugin.cpp',eligibility:'reviewable',properties:[],left:{text:left},right:{text:right}});
test('an unsupported old export is explicit even beside a supported export',()=>{
 const text='extern "C" bool Supported(int x)\n{\n return true;\n}\nextern "C" bool Zero()\n{\n return true;\n}';
 const out=buildMigrationContracts({id:'s',context:[],files:[file(text)]});
 assert.ok(out.limitations.some(s=>s.includes('Plugin.cpp:L5')&&s.includes('syntax unsupported')));
});
test('a new same-name export with different parameters cannot hide a removed old signature',()=>{
 const old='extern "C" bool Load(int x)\n{\n return true;\n}';
 const current='extern "C" bool Load(int x, int y)\n{\n return true;\n}';
 const out=buildMigrationContracts({id:'s',context:[],files:[file(old,current)]});
 assert.ok(out.limitations.some(s=>s.includes('Deleted old public entry')&&s.includes('(Load)')));
});
