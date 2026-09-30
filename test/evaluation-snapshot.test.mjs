import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { prepareEvaluationSnapshot } from '../evaluation/prepare-snapshot.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { reviewSnapshot } from '../src/review.mjs';
const root = fileURLToPath(new URL('../evaluation/', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../evaluation/manifest.json', import.meta.url), 'utf8'));
test('neutral snapshot identity excludes truth labels and works with review retrieval', async () => {
  const sample = manifest.cases[0];
  const snapshot = await prepareEvaluationSnapshot(root, sample);
  const relabelled = await prepareEvaluationSnapshot(root, { ...sample, id: 'other', expectedRegression: false });
  assert.deepEqual(snapshot, relabelled);
  assert.notEqual(snapshot.id, (await prepareEvaluationSnapshot(root, manifest.cases[1])).id);
  assert.deepEqual(createRetrievalScope(snapshot).catalog().map(c => c.path), ['subject.mjs', 'subject.mjs', 'contract.txt']);
  let calls = 0;
  const report = await reviewSnapshot(snapshot, async request => {
    calls++;
    assert.ok(request.input.includes('useResource'));
    assert.ok(!request.input.includes('expectedRegression'));
    assert.ok(!request.input.includes(sample.id));
    return { findings: [], limitations: [] };
  }, { enableRetrieval: true, enableVerification: true });
  assert.equal(calls, 1); assert.equal(report.coverage.completed, 1);
});
