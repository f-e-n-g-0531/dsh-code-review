import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadEvaluationInputs } from '../evaluation/load-inputs.mjs';
const root = fileURLToPath(new URL('../evaluation/', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../evaluation/manifest.json', import.meta.url), 'utf8'));
test('loader rejects oversized, UTF16, duplicate and linked inputs', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'evaluation-inputs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'lifecycle'));
  const sample = structuredClone(manifest.cases[0]);
  const first = path.join(dir, sample.inputs[0].path);
  await writeFile(first, 'x'.repeat(16385));
  await assert.rejects(loadEvaluationInputs(dir, sample), /size limit/);
  await writeFile(first, Buffer.from([255, 254, 65, 0]));
  await assert.rejects(loadEvaluationInputs(dir, sample), /must be UTF-8/);
  const duplicate = structuredClone(sample);
  duplicate.inputs[1].path = duplicate.inputs[0].path;
  await assert.rejects(loadEvaluationInputs(dir, duplicate), /input path/);
  await symlink(path.join(dir, 'lifecycle'), path.join(dir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  sample.inputs[0].path = 'linked/before.mjs';
  await assert.rejects(loadEvaluationInputs(dir, sample), /links and junctions/);
});
test('loader returns only pinned source and contract, not truth or revealing paths', async () => {
  for (const sample of manifest.cases) {
    const input = await loadEvaluationInputs(root, sample);
    assert.deepEqual(Object.keys(input), ['before', 'after', 'context']);
    for (const value of Object.values(input)) assert.deepEqual(Object.keys(value), ['text', 'sha256']);
    assert.ok(!JSON.stringify(input).includes(sample.id));
  }
});
test('loader rejects drift, traversal, and cancellation before returning any input', async () => {
  const drift = structuredClone(manifest.cases[0]); drift.inputs[0].sha256 = '0'.repeat(64);
  await assert.rejects(loadEvaluationInputs(root, drift), /hash mismatch/);
  const outside = structuredClone(manifest.cases[0]); outside.inputs[0].path = '../index.mjs';
  await assert.rejects(loadEvaluationInputs(root, outside), /Unsafe/);
  const c = new AbortController(); c.abort(new Error('cancelled'));
  await assert.rejects(loadEvaluationInputs(root, manifest.cases[0], { signal: c.signal }), /cancelled/);
});
