import test from 'node:test';import assert from 'node:assert/strict';import {inferCsharpContext} from '../src/csharp-context.mjs';
const primary={id:'p',path:'Main.cs',left:{text:'namespace App;\nUtil.Old();'},right:{text:'namespace App;\nUtil.New();'}};
const source=name=>'namespace App;\npublic static class Util {\n public static void '+name+'() {}\n}';
const input={files:[primary],history:{base:'before',target:'after'},context:[{path:'Util.cs',text:source('New'),oldText:source('Old')}]};
test('historical Csharp method hints resolve against corresponding captured version only',()=>{const r=inferCsharpContext(input,primary);assert.equal(r.length,2);assert.deepEqual(r.map(x=>[x.side,x.method,x.contextVersion,x.contextSide]),[['old','Old','before','old'],['new','New','after','new']]);});
test('missing baseline Csharp text cannot infer old method from target declaration',()=>{const p={...primary,left:primary.right};const r=inferCsharpContext({...input,files:[p],context:[{path:'Util.cs',text:source('New')}]},p);assert.deepEqual(r.map(x=>x.side),['new']);});
