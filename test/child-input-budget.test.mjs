import test from 'node:test';
import assert from 'node:assert/strict';
import { SNAPSHOT_TOOL_SCHEMA, registerSnapshotTool } from '../src/review-child-plugin.mjs';
import { buildReviewChildPrompt, buildReviewChildOutputSchema, buildReviewChildInitialEnvelope, measureChildInitialInput, DEFAULT_CHILD_HOST_RESERVE_BYTES } from '../src/child-input-budget.mjs';
const scope = { catalog: () => [{ id: 's1', fileId: 'f1', side: 'new', path: 'a.js', hash: 'a'.repeat(64) }], budget: () => ({ calls: 12, outputBytes: 65536 }) };
const request = (text = 'PRIVATE_SOURCE();') => ({ instructions: 'Review exact sources', input: JSON.stringify({ snapshotId: 's', sourceMode: 'group-primary', reviews: [{ fileId: 'f1', file: { properties: [{ name: 'property', old: 'old', new: text }], left: { text: 'old();' }, right: { text } } }], rules: [{ text: 'untrusted rules' }] }) });
const snapshotTool = { name: 'review_snapshot', description: 'Approved snapshot only', parameters: { type: 'object', properties: { requests: { type: 'array', items: { type: 'object' } } }, required: ['requests'] } };
test('prompt exactly matches host instructions plus full payload without double escaping or mutation', () => {
  const wire = request('quote" slash\\ newline\n中文😀'), before = structuredClone(wire);
  const expected = wire.instructions + '\nThe complete member bodies already in reviews are approved primary-review input; use them directly without rereading for receipts or line numbers. Use review_snapshot only for necessary supplemental approved sources not already supplied, not to repeat all member bodies. Preserve this child context for supplemental reads. Return final reviews via structured_output, never requests.\n' + JSON.stringify({ ...JSON.parse(wire.input), catalog: scope.catalog(), retrievalBudget: scope.budget() });
  assert.equal(buildReviewChildPrompt(wire, scope), expected);
  assert.deepEqual(JSON.parse(expected.slice(expected.indexOf('\n{') + 1)).reviews, JSON.parse(wire.input).reviews);
  assert.deepEqual(wire, before);
});
test('known transport bytes equal complete JSON envelope serialization with unicode escaping and large property', () => {
  const wire = request(('\u0000"\\中文😀\r\n').repeat(10000));
  const envelope = buildReviewChildInitialEnvelope(wire, scope, { snapshotTool });
  const measured = measureChildInitialInput(wire, scope, { maxInputBytes: 4 * 1024 * 1024, snapshotTool });
  assert.equal(measured.transportBytes, Buffer.byteLength(JSON.stringify(envelope)));
  assert.ok(measured.transportBytes > Buffer.byteLength(wire.input));
  assert.equal(measured.hostReserveBytes, 65536); assert.equal(measured.requiredBytes, measured.transportBytes + 65536);
  assert.equal(measured.includesSnapshotTool, true); assert.equal(measured.runtimeGuarantee, false);
  assert.deepEqual(JSON.parse(envelope.messages[0].content[0].text.slice(envelope.messages[0].content[0].text.indexOf('\n{') + 1)).reviews, JSON.parse(wire.input).reviews);
});
test('final structured schema excludes retrieval requests and keeps member finding identity fields', () => {
  const schema = buildReviewChildOutputSchema(request());
  assert.equal(schema.type, 'object'); assert.equal(schema.properties.requests, undefined); assert.equal(schema.oneOf, undefined);
  assert.ok(schema.required.includes('reviews')); assert.ok(schema.properties.reviews.items.required.includes('fileId'));
  assert.equal(schema.properties.reviews.items.properties.findings.items.properties.fileId.type, 'string');
});
test('exact boundary fits and declared reserve narrows candidate group sizes without guessing model capacity', () => {
  const wire = request('x'.repeat(40000));
  const raw = measureChildInitialInput(wire, scope, { maxInputBytes: 200000, hostReserveBytes: 0 });
  assert.equal(measureChildInitialInput(wire, scope, { maxInputBytes: raw.transportBytes, hostReserveBytes: 0 }).fits, true);
  assert.equal(measureChildInitialInput(wire, scope, { maxInputBytes: raw.transportBytes - 1, hostReserveBytes: 0 }).fits, false);
  const withReserve = measureChildInitialInput(wire, scope, { maxInputBytes: raw.transportBytes + DEFAULT_CHILD_HOST_RESERVE_BYTES - 1 });
  assert.equal(withReserve.fits, false); assert.equal(withReserve.availableBytes, raw.transportBytes - 1);
  const two = JSON.parse(wire.input); two.reviews.push({ ...two.reviews[0], fileId: 'f2' });
  const combined = { ...wire, input: JSON.stringify(two) };
  const cap = measureChildInitialInput(combined, scope, { maxInputBytes: 500000, hostReserveBytes: 0 }).transportBytes;
  assert.equal(measureChildInitialInput(combined, scope, { maxInputBytes: cap, hostReserveBytes: 0 }).fits, true);
  assert.equal(measureChildInitialInput(combined, scope, { maxInputBytes: cap }).fits, false);
  assert.equal(measureChildInitialInput(wire, scope, { maxInputBytes: cap }).fits, true);
});
test('measurement result is detached source-free numeric metadata and missing host schema is explicit', () => {
  const measured = measureChildInitialInput(request(), scope, { maxInputBytes: 512 * 1024 });
  assert.equal(measured.includesSnapshotTool, false); assert.ok(Object.isFrozen(measured));
  assert.ok(!JSON.stringify(measured).includes('PRIVATE_SOURCE'));
  const envelope = buildReviewChildInitialEnvelope(request(), scope, { snapshotTool });
  envelope.tools[0].parameters.required.push('changed'); assert.deepEqual(snapshotTool.parameters.required, ['requests']);
  assert.equal(measureChildInitialInput(request(), scope, { maxInputBytes: 1, hostReserveBytes: 2 }).availableBytes, 0);
});
test('exact production snapshot declaration is included unchanged in measured schema bytes', () => {
  let installed;
  registerSnapshotTool({ tools: { register: definition => { installed = definition; } } });
  const actual = { name: installed.name, description: installed.description, parameters: installed.parameters };
  assert.deepEqual(actual, SNAPSHOT_TOOL_SCHEMA);
  const wire = request(), envelope = buildReviewChildInitialEnvelope(wire, scope, { snapshotTool: SNAPSHOT_TOOL_SCHEMA });
  assert.deepEqual(envelope.tools[0], actual);
  assert.equal(envelope.tools[0].parameters.properties.requests.items.oneOf.length, 3);
  const measured = measureChildInitialInput(wire, scope, { maxInputBytes: 524288, snapshotTool: SNAPSHOT_TOOL_SCHEMA });
  assert.equal(measured.transportBytes, Buffer.byteLength(JSON.stringify(envelope)));
  assert.equal(measured.includesSnapshotTool, true);
  assert.equal('execute' in envelope.tools[0], false);
});
test('invalid input, capacity and reserve policies fail without silently enlarging budgets', () => {
  for (const options of [{}, { maxInputBytes: 0 }, { maxInputBytes: -1 }, { maxInputBytes: 1.5 }, { maxInputBytes: Infinity }, { maxInputBytes: 1, hostReserveBytes: -1 }, { maxInputBytes: 1, hostReserveBytes: 1.5 }, { maxInputBytes: 1, model: 'guess' }]) assert.throws(() => measureChildInitialInput(request(), scope, options));
  assert.throws(() => measureChildInitialInput(request(), scope, null));
  assert.throws(() => buildReviewChildPrompt({ instructions: '', input: '[]' }, scope));
  assert.throws(() => buildReviewChildOutputSchema({ instructions: '', input: '{}' }));
  assert.throws(() => buildReviewChildPrompt(request(), {}));
  assert.throws(() => buildReviewChildInitialEnvelope(request(), scope, { snapshotTool: { name: 'shell', parameters: {} } }));
});
