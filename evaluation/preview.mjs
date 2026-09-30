import { fileURLToPath } from 'node:url';
import { readLocal } from '../src/content.mjs';
import { prepareEvaluationSnapshot } from './prepare-snapshot.mjs';
import { buildCoveragePlan } from '../src/coverage-plan.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { REVIEW_INSTRUCTIONS } from '../src/review.mjs';

// CLI is deliberately offline: no provider, credentials, or execution mode.
const root = fileURLToPath(new URL('./', import.meta.url));
if (process.argv.length !== 2) throw new Error('This offline preview accepts no arguments');
const manifest = JSON.parse((await readLocal(root, 'manifest.json', { maxFileBytes: 65536 })).text);
if (manifest.version !== 1 || manifest.kind !== 'synthetic' || !Array.isArray(manifest.cases) || manifest.cases.length > 200) throw new Error('Invalid evaluation manifest');
const cases = [];
for (const sample of manifest.cases) {
  const snapshot = await prepareEvaluationSnapshot(root, sample);
  const plan = buildCoveragePlan(snapshot, { instructions: REVIEW_INSTRUCTIONS, scope: createRetrievalScope(snapshot), maxInputBytes: 96 * 1024 });
  cases.push({ snapshotId: snapshot.id, inputs: { before: snapshot.files[0].left.hash, after: snapshot.files[0].right.hash, contract: snapshot.context[0].hash }, plan });
}
console.log(JSON.stringify({ kind: 'offline-synthetic-preview', modelCalls: 0, approvalGranted: false, cases }, null, 2));
