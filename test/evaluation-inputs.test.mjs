import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadEvaluationInputs } from '../evaluation/load-inputs.mjs';
const root = fileURLToPath(new URL('../evaluation/', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../evaluation/manifest.json', import.meta.url), 'utf8'));
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
