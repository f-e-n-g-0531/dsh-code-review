import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureProjectRules } from '../src/project-rules.mjs';
import { captureProjectRules as historicalBefore } from '../evaluation/history-rule-extension/before/project-rules.mjs';
import { captureProjectRules as historicalAfter } from '../evaluation/history-rule-extension/after/project-rules.mjs';
// Exact predicate from 2b317cacbe6509888f0766e2b8457e692835ff7b.
const historicalAccepts = name => /.(md|txt)$/i.test(name);
test('historical extension predicate accepts unsupported name; current capture rejects actual file', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'rule-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'rulesmd'), 'Check resource cleanup.');
  assert.equal(historicalAccepts('rulesmd'), true);
  const accepted = await historicalBefore(root, ['rulesmd']);
  assert.equal(accepted[0].text, 'Check resource cleanup.');
  await assert.rejects(historicalAfter(root, ['rulesmd']), /Rules must be Markdown or text/);
  await assert.rejects(captureProjectRules(root, ['rulesmd']), /Rules must be Markdown or text/);
  for (const name of ['rules.md', 'rules.txt']) {
    await writeFile(path.join(root, name), 'Check resource cleanup.');
    assert.equal(historicalAccepts(name), true);
    const result = await captureProjectRules(root, [name]);
    assert.equal(result[0].path, name);
    for (const capture of [historicalBefore, historicalAfter]) assert.equal((await capture(root, [name]))[0].path, name);
  }
});
