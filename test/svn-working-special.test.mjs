import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,symlink,readFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {mkdir} from 'node:fs/promises';
import {readWorkingSvnSpecial} from '../src/svn-working-special.mjs';
// Deferred real filesystem acceptance; not executed during consolidated implementation.
test('working special link record never opens its outside target',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'dsh-special-record-'));t.after(async()=>{assert.ok(path.basename(dir).startsWith('dsh-special-record-'));await rm(dir,{recursive:true,force:true});});const target=path.join(dir,'outside.txt');await writeFile(target,'MUST NOT READ');
 // Native link creation may require Windows privilege; final acceptance must
 // report inability explicitly, never count a skipped case as supported.
 await symlink(target,path.join(dir,'link'));const value=await readWorkingSvnSpecial(dir,'link',{'svn:special':'*'});assert.equal(value.special.followed,false);assert.ok(!value.content.text.includes('MUST NOT READ'));assert.equal(await readFile(target,'utf8'),'MUST NOT READ');
 await writeFile(path.join(dir,'record'),'link ../missing');const regular=await readWorkingSvnSpecial(dir,'record',{'svn:special':'*'});assert.equal(regular.special.target,'../missing');
});
test('special link capture rejects changed ancestor identity',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'dsh-special-identity-'));t.after(()=>rm(root,{recursive:true,force:true}));const dir=path.join(root,'sub');await mkdir(dir);await symlink('outside',path.join(dir,'link'));
 const canonicalDir=await fs.promises.realpath(dir);const original=fs.promises.lstat;let checks=0;t.mock.method(fs.promises,'lstat',async(...args)=>{const stat=await original(...args);if(path.resolve(args[0]).toLowerCase()===path.resolve(canonicalDir).toLowerCase()&&++checks>1)return {isSymbolicLink:()=>false,isDirectory:()=>true,dev:stat.dev,ino:stat.ino+4096,ctimeMs:stat.ctimeMs};return stat;});
 syncBuiltinESMExports();try{await assert.rejects(readWorkingSvnSpecial(root,'sub/link',{'svn:special':'*'}),/ancestor changed/);assert.equal(checks,2);}finally{t.mock.restoreAll();syncBuiltinESMExports();}
});
