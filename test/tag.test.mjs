import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/process.mjs';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
test('CI tag must be a strict version matching package', async () => {
  const script = fileURLToPath(new URL('../scripts/verify-tag.mjs', import.meta.url));
  for (const [ref, expected] of [['refs/tags/v' + version, 0], ['refs/tags/v' + version + '0', 1], ['refs/tags/v00.1.0', 1], ['refs/heads/main', 1]]) {
    const result = await run(process.execPath, [script], { env: { GITHUB_REF: ref } });
    assert.equal(result.code, expected);
  }
});
