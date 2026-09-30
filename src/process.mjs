import { spawn } from 'node:child_process';

/** Run only adapter-owned commands. No shell, prompts, or unbounded capture. */
export function run(command, args, { cwd, signal, timeoutMs = 30_000, maxBytes = 8 * 1024 * 1024, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    for (const value of [timeoutMs, maxBytes]) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid command limit');
    const childEnv = { ...process.env, ...env };
    for (const key of Object.keys(childEnv)) if (/^GIT_/i.test(key)) delete childEnv[key];
    Object.assign(childEnv, { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1' });
    const child = spawn(command, args, {
      cwd, shell: false, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
    });
    const stdout = [], stderr = [];
    let bytes = 0, failure;
    const stop = error => { failure ??= error; child.kill(); };
    const abort = () => stop(signal.reason ?? new Error('Cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => stop(new Error('Command timeout')), timeoutMs);
    const capture = chunks => data => {
      bytes += data.length;
      if (bytes > maxBytes) stop(new Error('Command output limit exceeded'));
      else chunks.push(data);
    };
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    child.on('error', error => { failure ??= error; });
    child.on('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

export async function checked(command, args, options) {
  const result = await run(command, args, options);
  if (result.code !== 0) throw new Error(command + ' failed (' + result.code + '): ' + result.stderr.toString('utf8').slice(0, 2000));
  return result.stdout;
}
