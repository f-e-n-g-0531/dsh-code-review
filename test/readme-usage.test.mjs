import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {apply} from '../index.mjs';
import {svnHistoryRange} from '../src/svn-history.mjs';

test('README usage JSON examples match registered tool parameter names and SVN endpoint semantics',async()=>{
 const text=await readFile('README.md','utf8'),definitions=[];let dispose;
 apply({llm:{},tools:{register:d=>definitions.push(d)},on:(_event,fn)=>{dispose=fn;}});
 try {
  const preview=definitions.find(d=>d.name==='code_review_preview').parameters,execute=definitions.find(d=>d.name==='code_review_execute').parameters;
  const samples=[...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map(m=>JSON.parse(m[1]));assert.ok(samples.length>=8);
  for(const args of samples){const schema=args.previewId?execute:preview;for(const key of Object.keys(args)){assert.ok(Object.hasOwn(schema.properties,key),key);const spec=schema.properties[key];assert.equal(Array.isArray(args[key])?'array':typeof args[key],spec.type,key);}if(args.svnRevision||args.svnBaseRevision)svnHistoryRange(args);}
  assert.match(text,/DSH 对话输入框/);assert.match(text,/5 分钟/);assert.match(text,/不是逐一审查区间内的每个提交/);assert.ok(text.indexOf('## 快速开始')<text.indexOf('## 支持范围'));
 } finally {dispose();}
});
