import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshModel } from '../src/dsh-model.mjs';
import { modelJson } from '../src/model-json.mjs';
import { modelContract } from '../src/model-contract.mjs';
import { reviewSnapshot } from '../src/review.mjs';

const route = { provider: 'p', model: 'm' };
const request = () => ({ instructions: 'review', input: 'approved' });
const stop = { type: 'finish', reason: { kind: 'stop' } };
function scripted(outputs, options = {}) {
  const calls = [];
  const model = createDshModel({ async *stream(r) {
    calls.push(r);
    yield { type: 'text-delta', text: outputs[Math.min(calls.length - 1, outputs.length - 1)] };
    yield stop;
  } }, route, { correctJson: true, ...options });
  return { model, calls };
}

test('two bounded explicit corrections regenerate from identical input without replaying malformed output', async () => {
  const { model, calls } = scripted(['{PRIVATE first', '{PRIVATE second', '{"findings":[],"limitations":[]}']);
  const corrections = [], events = [];
  const result = await model({ ...request(), onProtocolCorrection: info => corrections.push(info), onProtocolEvent: info => events.push(info) });
  assert.deepEqual(JSON.parse(result), { findings: [], limitations: [] });
  assert.equal(calls.length, 3);
  assert.deepEqual(corrections.map(info => info.attempt), [2, 3]);
  assert.deepEqual(corrections.map(info => info.correction), [1, 2]);
  for (const call of calls) {
    assert.deepEqual(call.messages, calls[0].messages);
    assert.deepEqual(call.tools, []);
    assert.equal(call.maxTokens, 4096);
    assert.ok(!JSON.stringify(call).includes('PRIVATE'));
  }
  assert.match(calls[1].system, /明确协议纠正/);
  assert.ok(calls[2].system.includes('2/2'));
  assert.equal(events.length, 1);
  assert.equal(events[0].action, 'json-correction-complete');
  assert.equal(events[0].attempts.length, 3);
  assert.ok(!JSON.stringify([...corrections, ...events]).includes('PRIVATE'));
});

test('failed correction exhausts a hard bound and retains every redacted diagnostic', async () => {
  const { model, calls } = scripted(['{PRIVATE malformed']);
  await assert.rejects(model(request()), error => {
    assert.equal(error.code, 'MODEL_INVALID_JSON');
    assert.equal(error.attempts.length, 3);
    assert.match(error.message, /2 explicit JSON correction.*3 model calls.*budget exhausted/);
    assert.ok(!error.message.includes('no repair or retry'));
    for (const attempt of error.attempts) {
      assert.equal(attempt.diagnostic.finishKind, 'stop');
      assert.equal(attempt.diagnostic.visibleBytes, 18);
      assert.equal(attempt.diagnostic.shape, 'json-like-invalid');
      assert.equal(attempt.diagnostic.requestedMaxTokens, 4096);
      assert.equal(attempt.diagnostic.maxOutputBytes, 128 * 1024);
    }
    assert.ok(!JSON.stringify(error).includes('PRIVATE'));
    return true;
  });
  assert.equal(calls.length, 3);
});

test('correction may be disabled or tightened but cannot exceed two additional calls', async () => {
  for (const options of [{ correctJson: false }, { maxJsonCorrections: 0 }, { maxJsonCorrections: 1 }]) {
    const { model, calls } = scripted(['{bad'], options);
    await assert.rejects(model(request()), { code: 'MODEL_INVALID_JSON' });
    assert.equal(calls.length, options.maxJsonCorrections === 1 ? 2 : 1);
  }
  for (const maxJsonCorrections of [-1, 3, Infinity, 1.5, NaN]) {
    assert.throws(() => scripted(['{}'], { maxJsonCorrections }), /correction limit/);
  }
});

test('correction never adds metadata, changes stages, or corrupts valid JSON number spelling', async () => {
  const stages = [
    { instructions: 'verify', input: '{"candidates":[]}', output: '{"verdicts":[]}' },
    { instructions: '返回{groups:', input: '{}', output: '{"groups":[]}' },
    { instructions: '仅制定审查计划', input: '{"file":{}}', output: '{"risks":[]}' },
    { instructions: 'review', input: '{"file":{}}', output: '{"requests":[]}' },
    { instructions: 'review', input: '{"sourceMode":"file-interaction"}', output: '{"findings":[],"limitations":[]}' },
    { instructions: 'review', input: '{}', output: '{"large":9007199254740993,"overflow":1e400}' },
    { instructions: 'review', input: '{}', output: '{"findings":[],"limitations":' + JSON.stringify(Array(50).fill('limitation')) + '}' },
  ];
  for (const stage of stages) {
    const { model, calls } = scripted(['{bad', stage.output]);
    assert.equal(await model(stage), stage.output);
    const contract = modelContract(stage.input, stage.instructions);
    for (const call of calls) assert.ok(call.system.endsWith('\n' + contract));
    assert.equal(calls[1].messages[0].content[0].text, stage.input);
  }
});

test('async correction hooks cannot change the original approved input or stage contract', async () => {
  const { model, calls } = scripted(['{bad', '{"verdicts":[]}']);
  const r = { instructions: 'verify', input: '{"candidates":[]}' };
  r.onProtocolCorrection = async () => {
    r.input = '{"file":{"text":"unapproved"}}';
    r.instructions = 'review';
  };
  await model(r);
  assert.deepEqual(calls[1].messages, calls[0].messages);
  assert.ok(calls[1].system.startsWith('verify'));
  assert.ok(calls[1].system.endsWith(modelContract('{"candidates":[]}', 'verify')));
});

test('budget veto stops before the next model call', async () => {
  const { model, calls } = scripted(['{bad']);
  const veto = new Error('shared budget exhausted');
  let corrections = 0;
  await assert.rejects(model({ ...request(), onProtocolCorrection: () => {
    if (++corrections === 2) throw veto;
  } }), error => error === veto);
  assert.equal(calls.length, 2);
});

test('provider errors including a forged JSON code are not format-correction eligible', async () => {
  for (const code of ['MODEL_INVALID_JSON', 'RATE_LIMIT', undefined]) {
    for (const synchronous of [false, true]) {
      let calls = 0, corrections = 0;
      const expected = Object.assign(new Error('provider failed'), { code });
      const stream = synchronous ? () => { calls++; throw expected; } : async function* () { calls++; throw expected; };
      const model = createDshModel({ stream }, route, { correctJson: true });
      await assert.rejects(model({ ...request(), onProtocolCorrection: () => corrections++ }), error => error === expected);
      assert.equal(calls, 1);
      assert.equal(corrections, 0);
    }
  }
});

test('provider errors during correction preserve their identity even when frozen or primitive', async () => {
  for (const expected of [Object.freeze(new Error('provider failed')), null, 'provider failed']) {
    let calls = 0;
    const model = createDshModel({ async *stream() {
      if (++calls === 2) throw expected;
      yield { type: 'text-delta', text: '{bad' }; yield stop;
    } }, route, { correctJson: true });
    let rejected = false;
    try { await model(request()); } catch (error) { rejected = true; assert.equal(error, expected); }
    assert.ok(rejected);
    assert.equal(calls, 2);
  }
});

test('non-stop or missing finish, tool calls, trailing data and output limits never trigger correction', async () => {
  const cases = [
    ...['max-tokens', 'error', 'content-filter', 'cancelled'].map(kind => ({ chunks: [{ type: 'text-delta', text: '{bad' }, { type: 'finish', reason: { kind } }], code: 'MODEL_INCOMPLETE_OUTPUT' })),
    { chunks: [{ type: 'text-delta', text: '{bad' }], code: 'MODEL_INCOMPLETE_OUTPUT' },
    { chunks: [{ type: 'tool-call-delta' }], code: 'MODEL_PROTOCOL_ERROR' },
    { chunks: [stop, { type: 'text-delta', text: '{bad' }], code: 'MODEL_PROTOCOL_ERROR' },
    { chunks: [{ type: 'text-delta', text: '汉汉汉汉' }], code: 'MODEL_OUTPUT_LIMIT' },
    { chunks: [{ type: 'reasoning-delta', text: '123456789' }], code: 'MODEL_OUTPUT_LIMIT' },
  ];
  for (const { chunks, code } of cases) {
    let calls = 0, corrections = 0, closed = 0;
    const model = createDshModel({ async *stream() { calls++; try { yield* chunks; } finally { closed++; } } }, route, { correctJson: true, maxOutputBytes: 8 });
    await assert.rejects(model({ ...request(), onProtocolCorrection: () => corrections++ }), error => {
      assert.equal(error.code, code);
      assert.equal(typeof error.diagnostic.totalOutputBytes, 'number');
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(corrections, 0);
    assert.equal(closed, 1);
  }
});

test('corrected output exactly at the byte limit remains unchanged, with reasoning counted independently', async () => {
  let calls = 0;
  const output = '{"findings":[],"limitations":["汉"]}';
  const bytes = Buffer.byteLength(output);
  const model = createDshModel({ async *stream() {
    calls++;
    yield { type: 'text-delta', text: calls === 1 ? '{bad' : output }; yield stop;
  } }, route, { correctJson: true, maxOutputBytes: bytes });
  assert.equal(await model(request()), output);
  assert.equal(calls, 2);
  let correctionCalls = 0;
  const over = createDshModel({ async *stream() {
    correctionCalls++;
    yield { type: 'reasoning-delta', text: 'x' };
    yield { type: 'text-delta', text: output }; yield stop;
  } }, route, { correctJson: true, maxOutputBytes: bytes });
  await assert.rejects(over(request()), { code: 'MODEL_OUTPUT_LIMIT' });
  assert.equal(correctionCalls, 1);
});

test('terminal failure during correction stops immediately and retains preceding JSON diagnostic', async () => {
  let calls = 0;
  const model = createDshModel({ async *stream() {
    calls++;
    yield { type: 'text-delta', text: '{bad' };
    yield calls === 1 ? stop : { type: 'finish', reason: { kind: 'max-tokens' } };
  } }, route, { correctJson: true });
  await assert.rejects(model(request()), error => {
    assert.equal(error.code, 'MODEL_INCOMPLETE_OUTPUT');
    assert.equal(error.attempts.length, 2);
    assert.equal(error.attempts[0].code, 'MODEL_INVALID_JSON');
    assert.equal(error.attempts[1].diagnostic.finishKind, 'max-tokens');
    return true;
  });
  assert.equal(calls, 2);
});

test('cancellation before send, after stream finish, or in correction hook prevents additional sends', async () => {
  for (const timing of ['before', 'cleanup', 'hook']) {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    let calls = 0, corrections = 0;
    if (timing === 'before') controller.abort(reason);
    const model = createDshModel({ async *stream() {
      calls++;
      try { yield { type: 'text-delta', text: '{bad' }; yield stop; }
      finally { if (timing === 'cleanup') controller.abort(reason); }
    } }, route, { correctJson: true });
    await assert.rejects(model({ ...request(), signal: controller.signal, onProtocolCorrection: () => {
      corrections++;
      controller.abort(reason);
    } }), error => error === reason);
    assert.equal(calls, timing === 'before' ? 0 : 1);
    assert.equal(corrections, timing === 'hook' ? 1 : 0);
  }
});

test('strict parser does not repair syntax, partial fences, prose, or multiple values', () => {
  for (const text of ['{"a":1,}', '{"a":', 'prefix {}', '{} {}', '```json\n{}', '{"s":"unterminated}']) {
    assert.throws(() => modelJson(text), error => {
      assert.equal(error.code, 'MODEL_INVALID_JSON');
      assert.equal(error.diagnostic.jsonBytes, Buffer.byteLength(text));
      assert.ok(!error.message.includes(text));
      return true;
    });
  }
});

const snapshot = { id: 's', vcs: 'git', context: [], files: [{
  id: 'f', path: 'a.js', eligibility: 'reviewable', properties: [],
  left: { text: 'old();' }, right: { text: 'new();' },
}] };

test('downstream retrieval round gets its own bounded correction without losing receipts or call accounting', async () => {
  let calls = 0;
  const inputs = [], events = [];
  const model = createDshModel({ async *stream(r) {
    calls++;
    const p = JSON.parse(r.messages[0].content[0].text);
    inputs.push(p);
    const text = calls === 1 ? JSON.stringify({ requests: [{ kind: 'read', id: p.catalog[0].id, start: 1, count: 1 }] })
      : calls < 4 ? '{bad followup' : '{"findings":[],"limitations":[]}';
    yield { type: 'text-delta', text }; yield stop;
  } }, route, { correctJson: true });
  const report = await reviewSnapshot(snapshot, model, { enableRetrieval: true, maxCalls: 4, onProgress: info => events.push(info) });
  assert.equal(report.status, 'completed');
  assert.equal(report.modelCalls, 4);
  assert.equal(calls, 4);
  assert.equal(inputs[1].retrieved.length, 1);
  assert.deepEqual(inputs[1], inputs[2]);
  assert.deepEqual(inputs[2], inputs[3]);
  assert.equal(report.files[0].retrievalAudit.length, 1);
  assert.equal(events.filter(info => info.action === 'explicit-json-correction').length, 2);
  assert.equal(events.filter(info => info.action === 'json-correction-complete').length, 1);
});

test('review budget counts every extra call and blocks a correction before sending it', async () => {
  const { model, calls } = scripted(['{bad', '{bad again', '{"findings":[],"limitations":[]}']);
  const report = await reviewSnapshot(snapshot, model, { enableRetrieval: true, maxCalls: 2 });
  assert.equal(calls.length, 2);
  assert.equal(report.modelCalls, 2);
  assert.equal(report.status, 'failed');
  assert.equal(report.files[0].status, 'failed');
  assert.equal(report.findings.length, 0);
});

test('review persists every exhausted JSON attempt and never labels the file clean', async () => {
  const { model, calls } = scripted(['{PRIVATE malformed']);
  const report = await reviewSnapshot(snapshot, model, { enableRetrieval: true });
  assert.equal(calls.length, 3);
  assert.equal(report.modelCalls, 3);
  assert.equal(report.status, 'failed');
  assert.equal(report.files[0].failureCode, 'MODEL_INVALID_JSON');
  assert.equal(report.files[0].protocolAttempts.length, 3);
  assert.equal(report.files[0].protocolDiagnostic.finishKind, 'stop');
  assert.match(report.files[0].reason, /correction budget exhausted/);
  assert.ok(!JSON.stringify(report).includes('PRIVATE'));
  assert.equal(report.findings.length, 0);
});

test('valid JSON with invalid phase schema is still rejected downstream without a JSON correction', async () => {
  const { model, calls } = scripted(['{"verdicts":[]}']);
  const report = await reviewSnapshot(snapshot, model, { enableRetrieval: true });
  assert.equal(calls.length, 1);
  assert.equal(report.status, 'failed');
  assert.equal(report.findings.length, 0);
});
