import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checked } from '../src/process.mjs';
import { gitCallerIndex, validateCallerScopes } from '../src/caller-index.mjs';

test('caller scope rejects root wildcard secret unsafe and overlapping scopes', () => {
  for (const scopes of [[], ['.'], ['../src'], ['src/*'], ['src/?'], ['src/[x]'], ['.ssh'], ['src','src/nested'], ['src','src'], Array(5).fill('src')]) assert.throws(() => validateCallerScopes(scopes));
  assert.deepEqual(validateCallerScopes(['z','a']), ['a','z']);
});

test('caller index reads literal subtree only with identity changes and hard bounds', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-caller-index-'));
  t.after(async () => { assert.ok(path.basename(root).startsWith('dsh-caller-index-')); await rm(root, { recursive:true, force:true }); });
  const git = (...args) => checked('git', args, {cwd:root});
  await git('init');
  await mkdir(path.join(root,'src')); await mkdir(path.join(root,'src-other'));
  await writeFile(path.join(root,'src','a.ts'),'a');
  await writeFile(path.join(root,'src','untracked.ts'),'u');
  await writeFile(path.join(root,'src-other','b.ts'),'b');
  await writeFile(path.join(root,'single.ts'),'s');
  await git('add','src/a.ts','src-other','single.ts');
  const before = await gitCallerIndex(root,['src']);
  assert.deepEqual(before.paths,['src/a.ts']);
  await writeFile(path.join(root,'src-other','b.ts'),'new'); await git('add','src-other');
  assert.equal(before.fingerprint,(await gitCallerIndex(root,['src'])).fingerprint);
  await writeFile(path.join(root,'src','a.ts'),'new'); await git('add','src');
  assert.notEqual(before.fingerprint,(await gitCallerIndex(root,['src'])).fingerprint);
  await assert.rejects(gitCallerIndex(root,['single.ts']),/directory/);
  assert.deepEqual((await gitCallerIndex(root,['missing'])).paths,[]);
  await git('update-index','--add','--cacheinfo','120000,'+'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'+',src/link');
  assert.ok(!(await gitCallerIndex(root,['src'])).paths.includes('src/link'));
  for (let i=0;i<257;i++) await writeFile(path.join(root,'src',i+'.ts'),'x');
  await git('add','src');
  await assert.rejects(gitCallerIndex(root,['src']),/path limit/);
  const controller=new AbortController(); controller.abort();
  await assert.rejects(gitCallerIndex(root,['src'],{signal:controller.signal}));
});
