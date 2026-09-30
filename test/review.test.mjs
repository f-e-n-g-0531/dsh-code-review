import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewSnapshot, validateFindings, markdownReport } from '../src/review.mjs';
const file = () => ({ id: 'f1', path: 'a.js', eligibility: 'reviewable', left: { text: 'safe();\n' }, right: { text: 'unsafe();\n' }, properties: [{ name: 'svn:externals', old: null, new: 'x' }] });
const snapshot = () => ({ id: 'snapshot', vcs: 'git', files: [file()] });
const finding = () => ({ fileId: 'f1', severity: 'high', title: '具体问题', evidence: '缺少检查', trigger: '输入为空', impact: '抛出异常', suggestion: '增加检查', anchor: { kind: 'line', side: 'new', start: 1, end: 1, snippet: 'unsafe();' } });
const ok = async () => ({ findings: [], limitations: [] });
test('valid finding and exact snippet produce Chinese report', async () => {
  const result = await reviewSnapshot(snapshot(), async () => ({ findings: [finding(), finding()], limitations: [] }));
  assert.equal(result.status, 'partial'); assert.equal(result.findings.length, 1);
  assert.match(markdownReport(result), /缺少变更归因/);
  assert.equal(result.coverage.completed, 1); assert.match(markdownReport(result), /触发条件/);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(result)));
});
test('wrong file, lines, snippet, side and property are rejected', () => {
  for (const mutate of [f => f.fileId = 'other', f => f.anchor.start = 0, f => f.anchor.snippet = 'invented', f => f.anchor.side = 'other', f => f.anchor = { kind: 'property', name: 'unknown' }]) {
    const value = finding(); mutate(value); assert.throws(() => validateFindings({ findings: [value], limitations: [] }, file()));
  }
});
test('deletion old-side and properties are valid anchors', () => {
  const value = finding(); value.anchor = { kind: 'line', side: 'old', start: 1, end: 1, snippet: 'safe();' };
  assert.equal(validateFindings({ findings: [value], limitations: [] }, file()).findings.length, 1);
  value.anchor = { kind: 'property', name: 'svn:externals' };
  assert.equal(validateFindings({ findings: [value], limitations: [] }, file()).findings.length, 1);
});
test('invalid JSON is failed, not clean', async () => {
  const result = await reviewSnapshot(snapshot(), async () => 'not JSON');
  assert.equal(result.status, 'failed'); assert.match(markdownReport(result), /不能视为通过/);
});
test('budget and blocked files remain explicit partial coverage', async () => {
  const input = snapshot(); input.files.push({ ...file(), id: 'f2', path: 'second.js' }, { ...file(), id: 'f3', path: 'third.js', eligibility: 'blocked', reason: 'conflict' });
  const result = await reviewSnapshot(input, ok, { maxCalls: 1 });
  assert.equal(result.status, 'partial'); assert.equal(result.coverage.pending, 1); assert.equal(result.coverage.blocked, 1);
  const oversized = await reviewSnapshot(snapshot(), () => assert.fail('must not call'), { maxInputBytes: 10 });
  assert.equal(oversized.coverage.blocked, 1);
});
test('timeout and cancellation propagate to executor', async () => {
  let observed;
  const result = await reviewSnapshot(snapshot(), ({ signal }) => { observed = signal; return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }, { timeoutMs: 20 });
  assert.equal(result.status, 'failed'); assert.equal(observed.aborted, true);
  const controller = new AbortController(); controller.abort();
  const cancelled = await reviewSnapshot(snapshot(), () => assert.fail('must not call'), { signal: controller.signal });
  assert.equal(cancelled.status, 'cancelled');
});
test('timeout waits for executor cleanup before returning', async () => {
  let cleaned = false;
  const result = await reviewSnapshot(snapshot(), async ({ signal }) => {
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    await new Promise(resolve => setImmediate(resolve));
    cleaned = true;
    throw signal.reason;
  }, { timeoutMs: 10 });
  assert.equal(cleaned, true); assert.equal(result.status, 'failed');
});

test('snapshot mutation during call cannot change later input', async () => {
  const input = snapshot(); input.files.push({ ...file(), id: 'f2', path: 'second.js' }); let calls = 0;
  await reviewSnapshot(input, async request => {
    if (++calls === 1) input.files[1].right.text = 'mutated';
    else assert.equal(JSON.parse(request.input).file.right.text, 'unsafe();\n');
    return ok();
  });
});
test('invalid and duplicate snapshot entries are rejected before sending', async () => {
  const value = snapshot(); value.files.push(file());
  await assert.rejects(reviewSnapshot(value, () => assert.fail('no request')), /duplicate/);
  value.files = [{ ...file(), eligibility: 'unknown' }];
  await assert.rejects(reviewSnapshot(value, ok), /Invalid/);
  assert.throws(() => validateFindings('x'.repeat(128 * 1024 + 1), file()), /too large/);
});

test('model limitations produce partial and Markdown escapes active HTML', async () => {
  const result = await reviewSnapshot(snapshot(), async () => ({ findings: [], limitations: ['<img src=x onerror=alert(1)>'] }));
  assert.equal(result.status, 'partial'); assert.ok(!markdownReport(result).includes('<img')); assert.match(markdownReport(result), /&lt;img/);
});
