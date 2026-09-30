import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = new URL('../evaluation/', import.meta.url);
test('synthetic inputs and contracts are pinned independently of ground truth', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
  assert.equal(manifest.kind, 'synthetic');
  assert.equal(manifest.hashEncoding, 'utf8-lf');
  assert.equal(manifest.cases.length, 4);
  assert.equal(new Set(manifest.cases.map(c => c.id)).size, 4);
  for (const sample of manifest.cases) {
    assert.deepEqual(sample.inputs.map(i => i.role), ['before', 'after', 'context']);
    for (const input of sample.inputs) {
      assert.match(input.path, /^(lifecycle|stale-result)[/](before[.]mjs|after[.]mjs|guarded[.]mjs|contract[.]txt)$/);
      const text = (await readFile(new URL(input.path, root), 'utf8')).replaceAll('\r\n', '\n');
      assert.equal(createHash('sha256').update(text).digest('hex'), input.sha256);
    }
  }
});
