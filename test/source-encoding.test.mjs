import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { decode, hash, readLocal } from '../src/content.mjs';
import { captureProjectRules } from '../src/project-rules.mjs';
import { xml } from '../src/svn.mjs';

const chinese = Buffer.from([0xd6,0xd0,0xce,0xc4]);
const legacy = Buffer.concat([Buffer.from('// '),chinese,Buffer.from('\r\nint value = 1;\r\n')]);
const source = '// 中文\r\nint value = 1;\r\n';

test('UTF-8 with or without BOM and legacy GBK preserve exact decoded lines and raw identity', () => {
  const utf8 = Buffer.from(source), bom = Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),utf8]);
  for (const [bytes,encoding] of [[utf8,'utf-8'],[bom,'utf-8'],[legacy,'gbk']]) {
    const value=decode(bytes); assert.equal(value.text,source); assert.equal(value.encoding,encoding);
    assert.equal(value.hash,hash(bytes)); assert.equal(value.bytes,bytes.length); assert.ok(!value.text.includes('�'));
  }
  assert.notEqual(decode(utf8).hash,decode(legacy).hash); assert.notEqual(decode(utf8).hash,decode(bom).hash);
});

test('empty ASCII and ambiguous valid UTF-8 retain UTF-8 priority', () => {
  assert.equal(decode(Buffer.alloc(0)).encoding,'utf-8');
  assert.equal(decode(Buffer.from('int x = 1;\r\n')).encoding,'utf-8');
  assert.equal(decode(Buffer.from([0xc2,0xa9])).text,'©'); assert.equal(decode(Buffer.from([0xc2,0xa9])).encoding,'utf-8');
  assert.equal(decode(Buffer.from([0x80])).text,'€'); assert.equal(decode(Buffer.from([0x80])).encoding,'gbk');
});

test('existing replacement characters are not guessed away or repaired', () => {
  const bytes=Buffer.from('// already � in source\r\n'); const value=decode(bytes);
  assert.equal(value.text,'// already � in source\r\n'); assert.equal(value.encoding,'utf-8'); assert.equal(value.hash,hash(bytes));
});

test('declared Unicode BOM never falls back to legacy when corrupt', () => {
  for(const bytes of [[0xef,0xbb,0xbf,0xd6,0xd0],[0xff,0xfe,0x41],[0xfe,0xff,0x41],[0xff,0xfe,0x00,0xd8]]) assert.throws(()=>decode(Buffer.from(bytes)));
});

test('UTF-16 LE and BE with BOM keep existing exact Unicode semantics', () => {
  const le=Buffer.from(source,'utf16le'); const be=Buffer.from(le).swap16();
  for(const [bytes,encoding] of [[Buffer.concat([Buffer.from([0xff,0xfe]),le]),'utf-16le'],[Buffer.concat([Buffer.from([0xfe,0xff]),be]),'utf-16be']]) {
    const value=decode(bytes); assert.equal(value.text,source); assert.equal(value.encoding,encoding); assert.equal(value.hash,hash(bytes));
  }
});

test('malformed GBK, dangling pairs, GB18030 four-byte and binary remain blocked', () => {
  for(const bytes of [[0xff],[0x81],[0x81,0x7f],[0x81,0x30],[0xc3,0x28],[0x81,0x30,0x81,0x30],[0xd6,0xd0,0x81]]) assert.throws(()=>decode(Buffer.from(bytes)));
  for(const bytes of [Buffer.from([0]),Buffer.concat([chinese,Buffer.from([0])]),Buffer.from([0x50,0x4b,3,4]),Buffer.from([0x7f,0,0,0])]) assert.throws(()=>decode(bytes),/Binary/);
});

test('local reads do not transcode files; GBK rule files and metadata stay rejected',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'dsh-encoding-')); t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(path.join(root,'legacy.cpp'),legacy); await writeFile(path.join(root,'rules.md'),legacy);
  const value=await readLocal(root,'legacy.cpp'); assert.equal(value.text,source); assert.equal(value.encoding,'gbk'); assert.deepEqual(await readFile(path.join(root,'legacy.cpp')),legacy);
  await assert.rejects(captureProjectRules(root,['rules.md']),/Rules must use UTF-8/);
  assert.throws(()=>xml(Buffer.concat([Buffer.from('<info>'),chinese,Buffer.from('</info>')])));
});
