import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureProjectRules } from '../src/project-rules.mjs';
import { captureProjectRules as historicalBefore } from '../evaluation/history-rule-extension/before/project-rules.mjs';
import { captureProjectRules as historicalAfter } from '../evaluation/history-rule-extension/after/project-rules.mjs';
test('historical modules retain original Git blob identities without repository history', async () => {
  const expected = {
    'before/project-rules.mjs': 'ecf5a697650e03622fe645026bc75ccd996e6cc9',
    'after/project-rules.mjs': 'da8839c1985ed017d71db7a25fa2f10f64744802',
    'before/content.mjs': '95bf27f4588ddf89e715c236384651ba297a431a',
    'after/content.mjs': '95bf27f4588ddf89e715c236384651ba297a431a'
  };
  for (const [name, objectId] of Object.entries(expected)) {
    const text = await readFile(new URL('../evaluation/history-rule-extension/' + name, import.meta.url), 'utf8');
    // Match committed LF content even when Windows checkout converts line endings.
    const bytes = Buffer.from(text.replaceAll('\r\n', '\n'));
    const header = Buffer.from('blob ' + bytes.length + '\0');
    assert.equal(createHash('sha1').update(header).update(bytes).digest('hex'), objectId, name);
  }
});
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
