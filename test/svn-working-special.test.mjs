import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,symlink,readFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {readWorkingSvnSpecial} from '../src/svn-working-special.mjs';
// Deferred real filesystem acceptance; not executed during consolidated implementation.
test('working special link record never opens its outside target',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'dsh-special-record-'));t.after(async()=>{assert.ok(path.basename(dir).startsWith('dsh-special-record-'));await rm(dir,{recursive:true,force:true});});const target=path.join(dir,'outside.txt');await writeFile(target,'MUST NOT READ');
 // Native link creation may require Windows privilege; final acceptance must
 // report inability explicitly, never count a skipped case as supported.
 await symlink(target,path.join(dir,'link'));const value=await readWorkingSvnSpecial(dir,'link',{'svn:special':'*'});assert.equal(value.special.followed,false);assert.ok(!value.content.text.includes('MUST NOT READ'));assert.equal(await readFile(target,'utf8'),'MUST NOT READ');
 await writeFile(path.join(dir,'record'),'link ../missing');const regular=await readWorkingSvnSpecial(dir,'record',{'svn:special':'*'});assert.equal(regular.special.target,'../missing');
});
