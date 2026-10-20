import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess, { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { readLocal } from '../src/content.mjs';
import { run } from '../src/process.mjs';

// The outer process deadline contains regressions which block libuv's open worker.
function isolated(source, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.resume();
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeout);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('Isolated regression failed: ' + (signal ?? code) + '\n' + stderr));
    });
  });
}

test('FIFO replacement at open rejects without blocking or reading (Linux)', { skip: process.platform !== 'linux' }, async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dsh-fifo-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'file.js');
  await fs.promises.writeFile(filename, 'original');
  await isolated(
    "import assert from 'node:assert/strict'; import fs from 'node:fs'; import { execFileSync } from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module';" +
    'import { readLocal } from ' + JSON.stringify(new URL('../src/content.mjs', import.meta.url).href) + ';' +
    'const root=' + JSON.stringify(root) + '; const filename=' + JSON.stringify(filename) + ';' +
    "const original=fs.promises.open; let closed=false, reads=0; fs.promises.open=async(...args)=>{ fs.unlinkSync(filename); execFileSync('mkfifo',[filename]); const handle=await original(...args); return {stat:()=>handle.stat(),read:()=>{reads++;throw Error('must not read FIFO');},close:async()=>{closed=true;await handle.close();}}; }; syncBuiltinESMExports(); await assert.rejects(readLocal(root,'file.js'),/File changed during capture/); assert.equal(reads,0); assert.equal(closed,true);"
  );
});

test('non-regular opened handle rejects before read and closes (deterministic)', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dsh-open-kind-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  await fs.promises.writeFile(path.join(root, 'file.js'), 'original');
  let closed = false, reads = 0;
  t.mock.method(fs.promises, 'open', async (_name, flags) => {
    assert.equal(typeof flags, 'number');
    assert.equal(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC), 0);
    if (process.platform !== 'win32') assert.ok(flags & fs.constants.O_NONBLOCK);
    return { stat: async () => ({ isFile: () => false }), read: async () => { reads++; }, close: async () => { closed = true; } };
  });
  syncBuiltinESMExports();
  try { await assert.rejects(readLocal(root, 'file.js'), /File changed during capture/); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(reads, 0);
  assert.equal(closed, true);
});

for (const mode of ['timeout', 'abort']) {
  test(mode + ' settles after direct exit despite descendant holding stdout', { skip: process.platform !== 'linux' }, async t => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dsh-descendant-'));
    const pidfile = path.join(root, 'pid');
    t.after(async () => {
      try { process.kill(Number(await fs.promises.readFile(pidfile, 'utf8')), 'SIGKILL'); } catch (error) {
        if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    });
    await isolated(
      'import assert from "node:assert/strict"; import { run } from ' + JSON.stringify(new URL('../src/process.mjs', import.meta.url).href) + ';' +
      'const controller=new AbortController(); const start=Date.now(); const direct=' + JSON.stringify("const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setTimeout(()=>{},6000)'],{stdio:['ignore',1,2]}); require('node:fs').writeFileSync(" + JSON.stringify(pidfile) + ",String(child.pid)); child.unref();") + ';' +
      'const pending=run(process.execPath,["-e",direct],{timeoutMs:' + (mode === 'timeout' ? '350' : '0') + ',signal:controller.signal});' +
      (mode === 'abort' ? 'const timer=setTimeout(()=>controller.abort(Error("explicit abort")),350);' : '') +
      'await assert.rejects(pending,/' + (mode === 'timeout' ? 'Command timeout' : 'explicit abort') + '/); assert.ok(Date.now()-start<3000,"cancellation waited for inherited pipe EOF");' +
      (mode === 'abort' ? 'clearTimeout(timer);' : '')
    );
  });
}

for (const exited of [false, true]) {
  test('abort destroys owned pipes and joins direct child; exited=' + exited, async t => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: exited ? 0 : null, signalCode: null,
    });
    let destroyed = 0, settled = false;
    child.stdout.destroy = () => { destroyed++; };
    child.stderr.destroy = () => { destroyed++; };
    child.kill = () => true;
    t.mock.method(childProcess, 'spawn', () => child);
    syncBuiltinESMExports();
    const controller = new AbortController();
    const pending = run('fake', [], { signal: controller.signal });
    const observed = pending.then(() => { settled = true; }, error => { settled = true; throw error; });
    const rejected = assert.rejects(observed, /first abort/);
    controller.abort(Error('first abort'));
    try {
      assert.equal(destroyed, 2);
      await Promise.resolve();
      assert.equal(settled, false, 'pipe disposal must not resolve before direct child close');
      child.emit('close', 0);
      await rejected;
    } finally {
      child.emit('close', 0);
      t.mock.restoreAll(); syncBuiltinESMExports();
    }
  });
}

test('normal direct exit drains all stdout and stderr bytes', async () => {
  const size = 512 * 1024;
  const result = await run(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(' + size + ',97)); process.stderr.write(Buffer.alloc(' + size + ',98));'], { maxBytes: size * 2 });
  assert.equal(result.code, 0);
  assert.deepEqual(result.stdout, Buffer.alloc(size, 97));
  assert.deepEqual(result.stderr, Buffer.alloc(size, 98));
});
