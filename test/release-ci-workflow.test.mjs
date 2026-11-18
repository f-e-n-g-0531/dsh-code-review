import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflow = () => readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

test('frozen tag package check is confined to one read-only test cell', async () => {
  const [testJob] = (await workflow()).split(/^  release:/m);
  assert.match(testJob, /if: github.event_name != 'workflow_dispatch' \|\| !inputs.publish/);
  assert.match(testJob, /^    permissions:\r?\n      contents: read$/m);
  assert.match(testJob, /ref: \$\{\{ github.sha \}\}/);
  assert.match(testJob, /name: Verify frozen-tag package install\s+if: startsWith\(github.ref, 'refs\/tags\/'\) && matrix.os == 'ubuntu-latest' && matrix.node == 24/);
  assert.match(testJob, /persist-credentials: false/);
  assert.match(testJob, /npm pack --ignore-scripts --pack-destination/);
  assert.match(testJob, /npm install --ignore-scripts/);
  assert.match(testJob, /node .*scripts\/verify-installed.mjs/);
  assert.doesNotMatch(testJob, /NPM_AUTOMATION_TOKEN|NODE_AUTH_TOKEN|npm publish|gh release/);
});

test('publication verifies CI evidence and independently checks the exact shipped artifacts', async () => {
  const [, release] = (await workflow()).split(/^  release:/m);
  assert.ok(release.includes('RELEASE_CI_RUN_ID: ${{ inputs.ci_run_id }}'));
  assert.ok(release.includes('actions: read'));
  const steps = ['run: node scripts/verify-release-ci.mjs', 'name: Pack and verify install', 'npm pack', 'npm install', 'node "$GITHUB_WORKSPACE/scripts/verify-installed.mjs"', 'name: Preserve exact release artifact', 'npm publish ./release/*.tgz', 'run: node scripts/verify-published.mjs', 'gh release create', 'gh release download', 'cmp "release/$package"', 'sha256sum --check'];
  let last = -1;
  for (const step of steps) {
    const index = release.indexOf(step);
    assert.ok(index > last, 'Missing or out of order: ' + step);
    last = index;
  }
});
