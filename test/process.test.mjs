import test from 'node:test';
import assert from 'node:assert/strict';
import { run, checked } from '../src/process.mjs';

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

test('pre-cancelled request never starts', async () => {
  await assert.rejects(run(process.execPath, [], { signal: AbortSignal.abort(new Error('already cancelled')) }), /already cancelled/);
});
