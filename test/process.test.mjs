import test from 'node:test';
import assert from 'node:assert/strict';
import { run, checked } from '../src/process.mjs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';

test('captures bytes and exit code without invoking a shell', async () => {
  const result = await run(process.execPath, ['-e', 'process.stdout.write(process.argv[1]); process.exitCode=7', 'a & echo injected']);
  assert.equal(result.code, 7);
  assert.equal(result.stdout.toString(), 'a & echo injected');
});
test('checked rejects unsuccessful commands', async () => {
  await assert.rejects(checked(process.execPath, ['-e', 'process.exit(2)']), /failed/);
});
test('bounded output', async () => {
  await assert.rejects(run(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000))'], { maxBytes: 100 }), /output limit/);
});
test('timeout kills process', async () => {
  await assert.rejects(run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 }), /timeout/);
});
test('cancellation propagates', async () => {
  const controller = new AbortController();
  const promise = run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
  controller.abort(new Error('test cancellation'));
  await assert.rejects(promise, /test cancellation/);
});
test('ambient Git routing and config injection are removed', async () => {
  const result = await run(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { env: { GIT_DIR: '/wrong', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'malicious' } });
  const env = JSON.parse(result.stdout.toString());
  assert.equal(env.GIT_DIR, undefined); assert.equal(env.GIT_CONFIG_COUNT, undefined);
  assert.equal(env.GIT_NO_LAZY_FETCH, '1');
});

test('repeated stop triggers share one escalation timer and retain first failure', async t => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null, signalCode: null,
  });
  const kills = [], timers = [], cleared = [];
  child.kill = signal => { kills.push(signal); return true; };
  t.mock.method(childProcess, 'spawn', () => child);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const timer = { callback, delay, unref() {} }; timers.push(timer); return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', timer => cleared.push(timer));
  const controller = new AbortController();
  const pending = run('fake', [], { maxBytes: 1, timeoutMs: 10, signal: controller.signal });
  for (let i = 0; i < 30; i++) child.stdout.emit('data', Buffer.from('overflow'));
  controller.abort(new Error('later abort'));
  timers.find(timer => timer.delay === 10).callback();
  assert.deepEqual(kills, [undefined]);
  assert.equal(timers.filter(timer => timer.delay === 1000).length, 1);
  assert.equal(child.listenerCount('close'), 1);
  const killer = timers.find(timer => timer.delay === 1000);
  killer.callback();
  assert.deepEqual(kills, [undefined, 'SIGKILL']);
  child.exitCode = 0;
  killer.callback();
  assert.equal(kills.length, 2, 'do not kill a process that already exited');
  child.emit('close', 0);
  await assert.rejects(pending, /output limit/);
  assert.ok(cleared.includes(killer));
  assert.ok(cleared.includes(timers.find(timer => timer.delay === 10)));
});

test('pre-cancelled request never starts', async () => {
  await assert.rejects(run(process.execPath, [], { signal: AbortSignal.abort(new Error('already cancelled')) }), /already cancelled/);
});
