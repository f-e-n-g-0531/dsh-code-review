import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readLocal } from '../src/content.mjs';

test('opened identity mismatch is rejected before any read and handle closes', async t => {
 const root=await mkdtemp(path.join(os.tmpdir(),'dsh-content-identity-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(path.join(root,'a.js'),'safe');const original=fs.promises.open;let reads=0,closed=false;
 t.mock.method(fs.promises,'open',async(...args)=>{const handle=await original(...args);return {stat:async()=>{const stat=await handle.stat();return {isFile:()=>true,dev:stat.dev,ino:stat.ino+4096};},read:async()=>{reads++;throw Error('must not read');},close:async()=>{closed=true;await handle.close();}};});
 syncBuiltinESMExports();try{await assert.rejects(readLocal(root,'a.js'),/File changed during capture/);assert.equal(reads,0);assert.equal(closed,true);}finally{t.mock.restoreAll();syncBuiltinESMExports();}
});

test('ancestor identity changes are rejected before returning captured text',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'dsh-content-identity-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const dir=path.join(root,'sub');await mkdir(dir);await writeFile(path.join(dir,'a.js'),'safe');const original=fs.promises.lstat;let checks=0;
 t.mock.method(fs.promises,'lstat',async(...args)=>{const stat=await original(...args);if(path.resolve(args[0]).toLowerCase()===path.resolve(dir).toLowerCase()&&++checks>1)return {isSymbolicLink:()=>false,isDirectory:()=>true,dev:stat.dev,ino:stat.ino+4096,ctimeMs:stat.ctimeMs};return stat;});
 syncBuiltinESMExports();try{await assert.rejects(readLocal(root,'sub/a.js'),/Ancestor changed during capture/);assert.equal(checks,2);}finally{t.mock.restoreAll();syncBuiltinESMExports();}
});
