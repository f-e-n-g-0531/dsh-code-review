import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkConfig, benchmarkExecutor, benchmarkFindings, runBenchmark } from '../scripts/review-bench-adapter.mjs';
import { mkdtemp, writeFile, readFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checked } from '../src/process.mjs';

const environment = { RB_BASE: 'a'.repeat(40), RB_HEAD: 'b'.repeat(40), RB_NWO: 'owner/repo', RB_PR_NUMBER: '1', RB_REPO_DIR: '.', RB_OUT: 'candidate.json', RB_MOCK: '1' };
const snapshot = { files: [{ id: 'f', path: 'src/a.js' }] };
const finding = { fileId: 'f', title: 'Bug', evidence: 'Evidence', trigger: 'Trigger', impact: 'Impact', suggestion: 'Fix', anchor: { kind: 'line', side: 'new', start: 1, end: 1 } };
const report = findings => ({ status: 'completed', files: [{ fileId: 'f', status: 'completed' }], findings });

test('benchmark local smoke captures fixed Git objects without producing a scoreable result', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-benchmark-local-'));
  const git = (...args) => checked('git', args, { cwd: root });
  await git('init', '-q');
  await git('config', 'user.name', 'test');
  await git('config', 'user.email', 'test@example.com');
  await writeFile(path.join(root, 'sample.js'), 'const value = 1;\n');
  await git('add', 'sample.js'); await git('commit', '-qm', 'base');
  const base = (await git('rev-parse', 'HEAD')).toString('utf8').trim();
  await writeFile(path.join(root, 'sample.js'), 'const value = 2;\n');
  await git('commit', '-qam', 'head');
  const head = (await git('rev-parse', 'HEAD')).toString('utf8').trim();
  const before = await git('status', '--porcelain');
  const out = path.join(root, 'candidate.json');
  await runBenchmark({ ...environment, RB_REPO_DIR: root, RB_BASE: base, RB_HEAD: head, RB_OUT: out });
  await assert.rejects(access(out), { code: 'ENOENT' });
  const saved = JSON.parse(await readFile(out + '.report.json', 'utf8'));
  assert.equal(saved.mock, true); assert.equal(saved.report.status, 'completed');
  assert.equal(JSON.parse(await readFile(out + '.smoke.json', 'utf8')).pr.head, head);
  // The untracked result files are the adapter's outputs, not source mutations.
  assert.equal(await readFile(path.join(root, 'sample.js'), 'utf8'), 'const value = 2;\n');
  assert.equal(before.length, 0);
  await assert.rejects(runBenchmark({ ...environment, RB_REPO_DIR: root, RB_BASE: base, RB_HEAD: head, RB_OUT: out }), { code: 'EEXIST' });
});

test('benchmark configuration requires explicit local scope and model destination', () => {
  assert.equal(benchmarkConfig(environment).mock, true);
  for (const override of [{ RB_BASE: '--option' }, { RB_NWO: '../repo' }, { RB_PR_NUMBER: '1x' }, { RB_REPO_DIR: '' }, { RB_MOCK: 'maybe' }]) assert.throws(() => benchmarkConfig({ ...environment, ...override }));
  assert.throws(() => benchmarkConfig({ ...environment, RB_MOCK: '0' }), /explicit/);
  const live = { ...environment, RB_MOCK: '0', RB_CONFIG_MODEL: 'test', RB_MODEL_BASE_URL: 'https://example.test/v1' };
  assert.equal(benchmarkConfig(live).endpoint, 'https://example.test/v1/chat/completions');
  for (const url of ['http://example.test', 'https://user:secret@example.test', 'https://example.test?secret=1']) assert.throws(() => benchmarkConfig({ ...live, RB_MODEL_BASE_URL: url }));
  assert.equal(benchmarkConfig({ ...live, ANTHROPIC_API_KEY: 'not-openai-compatible' }).apiKey, '');
});

test('benchmark preserves same-line distinct findings and deduplicates only exact output', () => {
  const result = benchmarkFindings(snapshot, report([finding, finding, { ...finding, title: 'Different bug' }]), 'agent');
  assert.equal(result.length, 2);
  assert.equal(result[0].file, 'src/a.js');
  assert.match(result[0].message, /Trigger/);
});

test('benchmark refuses incomplete or unrepresentable output instead of a clean result', () => {
  for (const status of ['partial', 'failed', 'cancelled']) assert.throws(() => benchmarkFindings(snapshot, { ...report([]), status }, 'agent'), /incomplete/);
  assert.throws(() => benchmarkFindings(snapshot, { ...report([]), files: [] }, 'agent'), /incomplete/);
  for (const anchor of [{ ...finding.anchor, side: 'old' }, { kind: 'file' }, { ...finding.anchor, start: 0 }]) assert.throws(() => benchmarkFindings(snapshot, report([{ ...finding, anchor }]), 'agent'), /head-side/);
  assert.throws(() => benchmarkFindings(snapshot, report([{ ...finding, fileId: 'unknown' }]), 'agent'), /path/);
  assert.throws(() => benchmarkFindings(snapshot, report([{ ...finding, verification: { status: 'completed', verdict: 'refuted' } }]), 'agent'), /adjudication/);
  assert.throws(() => benchmarkFindings(snapshot, report(Array.from({ length: 201 }, (_, i) => ({ ...finding, title: String(i) }))), 'agent'), /no clipping/);
});

test('benchmark client keeps strict JSON and rejects truncation and error body disclosure', async () => {
  const request = { instructions: 'system', input: '{}', signal: new AbortController().signal };
  const response = (text, finish = 'stop') => new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { content: text } }] }));
  let sent;
  const executor = benchmarkExecutor({ endpoint: 'https://example.test', model: 'm', apiKey: 'secret' }, async (url, options) => { sent = options; return response('```json\n{"findings":[],"limitations":[]}\n```'); });
  assert.deepEqual(await executor(request), { findings: [], limitations: [] });
  assert.equal(sent.redirect, 'error');
  for (const text of ['prefix {"findings":[]}', '{} {}', '```json\n{}\n``` trailing']) await assert.rejects(benchmarkExecutor({}, async () => response(text))(request), /complete JSON/);
  await assert.rejects(benchmarkExecutor({}, async () => response('{}', 'length'))(request), /incomplete/);
  await assert.rejects(benchmarkExecutor({}, async () => new Response('PRIVATE_SOURCE secret', { status: 401 }))(request), error => error.message === 'Model HTTP status 401');
  await assert.rejects(benchmarkExecutor({}, async () => new Response('x'.repeat(1024 * 1024 + 1)))(request), /byte limit/);
});
