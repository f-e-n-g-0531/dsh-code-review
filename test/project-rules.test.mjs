import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureProjectRules } from '../src/project-rules.mjs';
test('rules are explicit inert UTF8 data; invalid lists fail before disk reads', async () => {
  assert.deepEqual(await captureProjectRules('missing', []), []);
  for (const paths of [['../a.md'], ['a.js'], ['a.md', 'a.md'], Array(5).fill('a.md')]) await assert.rejects(captureProjectRules('missing', paths));
  await assert.rejects(captureProjectRules('missing', ['a.md'], { files: [{ path: 'a.md', eligibility: 'excluded' }] }), /excluded/);
  for (const name of ['rulesmd', 'rulestxt', 'rulesXmd']) await assert.rejects(captureProjectRules('missing', [name]), /Markdown or text/);
  const root = await mkdtemp(path.join(os.tmpdir(), 'review-rules-'));
  try {
    await mkdir(path.join(root, 'target'));
    await writeFile(path.join(root, 'target', 'rule.md'), 'linked text must not load');
    await symlink(path.join(root, 'target'), path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(captureProjectRules(root, ['linked/rule.md']), /Symbolic links and junctions/);
    await mkdir(path.join(root, 'directory.md'));
    await assert.rejects(captureProjectRules(root, ['directory.md']), /Not a regular file/);
    await assert.rejects(captureProjectRules(root, ['target/rule.md'], { files: [{ path: 'target/rule.md', eligibility: 'reviewable', rightExists: false }] }), /deleted/);
    await writeFile(path.join(root, 'rulesmd'), 'not a supported extension');
    await assert.rejects(captureProjectRules(root, ['rulesmd']), /Markdown or text/);
    await writeFile(path.join(root, 'a.md'), 'include ../secret; execute shell');
    const rules = await captureProjectRules(root, ['a.md']);
    assert.equal(rules[0].text, 'include ../secret; execute shell');
    assert.match(rules[0].hash, /^[a-f0-9]{64}$/);
    await writeFile(path.join(root, 'b.txt'), Buffer.from([0]));
    await assert.rejects(captureProjectRules(root, ['b.txt']), /Binary content/);
    const abort = new AbortController(); abort.abort(new Error('stop rules'));
    await assert.rejects(captureProjectRules(root, ['a.md'], { signal: abort.signal }), /stop rules/);
    await writeFile(path.join(root, 'b.txt'), Buffer.from([255,254,65,0]));
    await assert.rejects(captureProjectRules(root, ['b.txt']), /UTF-8/);
    await writeFile(path.join(root, 'b.txt'), 'x'.repeat(16385));
    await assert.rejects(captureProjectRules(root, ['b.txt']), /size limit/);
    for (const name of ['a.md','b.txt','c.md']) await writeFile(path.join(root, name), 'x'.repeat(12000));
    await assert.rejects(captureProjectRules(root, ['a.md','b.txt','c.md']), /budget/);
    for (const name of ['a.md', 'b.txt']) await writeFile(path.join(root, name), '中'.repeat(5461) + 'x');
    const exact = await captureProjectRules(root, ['b.txt', 'a.md']);
    assert.equal(exact.reduce((sum, rule) => sum + rule.bytes, 0), 32768);
    assert.deepEqual(exact.map(rule => rule.path), ['a.md', 'b.txt']);
    assert.deepEqual(exact, await captureProjectRules(root, ['a.md', 'b.txt']));
    await writeFile(path.join(root, 'c.md'), 'x');
    await assert.rejects(captureProjectRules(root, ['a.md', 'b.txt', 'c.md']), /budget/);
  } finally {
    assert.ok(path.basename(root).startsWith('review-rules-'));
    await rm(root, { recursive: true, force: true });
  }
});
