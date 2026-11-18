import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkConfig, benchmarkExecutor, benchmarkFindings, reviewBenchmarkSnapshot, runBenchmark } from '../scripts/review-bench-adapter.mjs';
import { mkdtemp, writeFile, readFile, access, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checked } from '../src/process.mjs';
import { captureSnapshot } from '../src/snapshot.mjs';

const environment = { RB_BASE: 'a'.repeat(40), RB_HEAD: 'b'.repeat(40), RB_NWO: 'owner/repo', RB_PR_NUMBER: '1', RB_REPO_DIR: '.', RB_OUT: 'candidate.json', RB_MOCK: '1' };
const snapshot = { files: [{ id: 'f', path: 'src/a.js' }] };
const finding = { fileId: 'f', title: 'Bug', evidence: 'Evidence', trigger: 'Trigger', impact: 'Impact', suggestion: 'Fix', anchor: { kind: 'line', side: 'new', start: 1, end: 1 } };
const report = findings => ({ status: 'completed', files: [{ fileId: 'f', status: 'completed' }], findings });

test('benchmark local smoke captures fixed Git objects without producing a scoreable result', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-benchmark-local-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const git = (...args) => checked('git', args, { cwd: root });
  await git('init', '-q');
  await git('config', 'user.name', 'test');
  await git('config', 'user.email', 'test@example.com');
  await writeFile(path.join(root, 'sample.js'), 'const value = 1;\n');
  await writeFile(path.join(root, 'other.js'), 'const other = 1;\n');
  await git('add', 'sample.js', 'other.js'); await git('commit', '-qm', 'base');
  const base = (await git('rev-parse', 'HEAD')).toString('utf8').trim();
  await writeFile(path.join(root, 'sample.js'), 'const value = 2;\n');
  await writeFile(path.join(root, 'other.js'), 'const other = 2;\n');
  await git('commit', '-qam', 'head');
  const head = (await git('rev-parse', 'HEAD')).toString('utf8').trim();
  const before = await git('status', '--porcelain');
  const out = path.join(root, 'candidate.json');
  await runBenchmark({ ...environment, RB_REPO_DIR: root, RB_BASE: base, RB_HEAD: head, RB_OUT: out });
  await assert.rejects(access(out), { code: 'ENOENT' });
  const saved = JSON.parse(await readFile(out + '.report.json', 'utf8'));
  assert.equal(saved.mock, true); assert.equal(saved.report.status, 'completed');
  assert.equal(saved.profile, 'staged-direct'); assert.equal(saved.executionStrategy, 'staged');
  assert.equal(saved.report.modelCalls, 2);
  const singleOut = path.join(root, 'single.json');
  await runBenchmark({ ...environment, RB_PROFILE: 'single-pass-direct', RB_REPO_DIR: root, RB_BASE: base, RB_HEAD: head, RB_OUT: singleOut });
  await assert.rejects(access(singleOut), { code: 'ENOENT' });
  const single = JSON.parse(await readFile(singleOut + '.report.json', 'utf8'));
  assert.equal(single.profile, 'single-pass-direct'); assert.equal(single.report.orchestration.strategy, 'single-pass');
  assert.equal(single.report.modelCalls, 1); assert.equal(single.report.coverage.completed, 2);
  const captured = await captureSnapshot(root, { baseRevision: base, targetRevision: head });
  const primary = captured.files.find(f => f.path === 'sample.js');
  const makeFinding = (side = 'new') => ({ ...finding, fileId: primary.id, severity: 'high',
    anchor: { ...finding.anchor, side, snippet: 'const value = ' + (side === 'new' ? '2' : '1') + ';' },
    attribution: { editIds:['e1'], properties:[], beforeBehavior:'returns 1', afterBehavior:'returns 2', reason:'const value changed' },
  });
  async function evaluate(side) {
    let calls = 0;
    const complete = { status: 'completed', gaps: [] };
    const result = await reviewBenchmarkSnapshot(captured, async request => {
      calls++; await request.beforeSend();
      const input = JSON.parse(request.input);
      assert.equal(input.reviews.length, 2);
      return { reviews: input.reviews.map(({fileId}) => ({ fileId, findings: fileId === primary.id ? [makeFinding(side)] : [], limitations:[], completion:complete })), limitations:[], completion:complete };
    }, 'single-pass');
    assert.equal(calls, 1); assert.equal(result.status, 'completed'); assert.equal(result.findings[0].verification.status, 'not-requested');
    return result;
  }
  const candidate = await evaluate('new');
  assert.equal(benchmarkFindings(captured, candidate, 'offline')[0].file, 'sample.js');
  const old = await evaluate('old');
  assert.throws(() => benchmarkFindings(captured, old, 'offline'), /head-side/);
  candidate.findings[0].validation.anchor = 'unchecked';
  assert.throws(() => benchmarkFindings(captured, candidate, 'offline'), /adjudication/);
  const huge = structuredClone(captured);
  huge.files[0].right.text = 'A'.repeat(100_000);
  const blocked = await reviewBenchmarkSnapshot(huge, () => assert.fail('oversize review must not send'), 'single-pass');
  assert.equal(blocked.modelCalls, 0); assert.equal(blocked.orchestration.inputBudget.fits, false);
  assert.equal(JSON.parse(await readFile(out + '.smoke.json', 'utf8')).pr.head, head);
  // The untracked result files are the adapter's outputs, not source mutations.
  assert.equal(await readFile(path.join(root, 'sample.js'), 'utf8'), 'const value = 2;\n');
  assert.equal(before.length, 0);
  await assert.rejects(runBenchmark({ ...environment, RB_REPO_DIR: root, RB_BASE: base, RB_HEAD: head, RB_OUT: out }), { code: 'EEXIST' });
});

test('benchmark configuration requires explicit local scope and model destination', () => {
  assert.equal(benchmarkConfig(environment).mock, true);
  for (const override of [{ RB_BASE: '--option' }, { RB_NWO: '../repo' }, { RB_PR_NUMBER: '1x' }, { RB_REPO_DIR: '' }, { RB_MOCK: 'maybe' }, { RB_PROFILE: 'unknown' }]) assert.throws(() => benchmarkConfig({ ...environment, ...override }));
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
