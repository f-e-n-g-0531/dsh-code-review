import test from 'node:test';
import assert from 'node:assert/strict';
import { modelContract, JSON_TRANSPORT_GUIDE } from '../src/model-contract.mjs';
import { modelJson } from '../src/model-json.mjs';
import { RISK_PLAN_INSTRUCTIONS, BUSINESS_GROUP_INSTRUCTIONS, REVIEW_INSTRUCTIONS, INLINE_RISK_INSTRUCTIONS, RETRIEVAL_INSTRUCTIONS } from '../src/prompts.mjs';

const stages = [
  [{ file: { id: 'f' } }, REVIEW_INSTRUCTIONS, 'findings'],
  [{ file: { id: 'f' } }, REVIEW_INSTRUCTIONS + INLINE_RISK_INSTRUCTIONS, 'findings'],
  [{ file: { id: 'f' }, sourceMode: 'file-interaction' }, REVIEW_INSTRUCTIONS, 'interaction.editRefs'],
  [{}, RISK_PLAN_INSTRUCTIONS, 'risks'],
  [{}, BUSINESS_GROUP_INSTRUCTIONS, 'groups'],
  [{ candidates: [{ candidateId: 'c' }] }, '', 'verdicts'],
  [{ file: { id: 'f' }, retrieved: [] }, REVIEW_INSTRUCTIONS + RETRIEVAL_INSTRUCTIONS, 'findings'],
];

test('all supported stage contracts append one bounded JSON encoding guide after their schema', () => {
  assert.ok(Buffer.byteLength(JSON_TRANSPORT_GUIDE) <= 300);
  for (const [payload, instructions, schema] of stages) {
    const contract = modelContract(JSON.stringify(payload), instructions);
    assert.ok(contract.includes(schema));
    assert.ok(contract.endsWith(JSON_TRANSPORT_GUIDE));
    assert.equal(contract.split(JSON_TRANSPORT_GUIDE).length - 1, 1);
    assert.ok(contract.indexOf(schema) < contract.indexOf(JSON_TRANSPORT_GUIDE));
    assert.match(contract, /ASCII double quotes/);
    assert.ok(contract.includes('JSON-escape backslashes, quotes and CR/LF'));
    assert.ok(contract.includes('preserving decoded paths/source/snippets exactly'));
    assert.ok(contract.includes('retain required fields/evidence'));
  }
});

test('guide deduplicates exact existing transport guidance but not a generic mention of JSON', () => {
  const payload = JSON.stringify({ file: { id: 'f' } });
  assert.ok(modelContract(payload, 'JSON').includes(JSON_TRANSPORT_GUIDE));
  const instructions = REVIEW_INSTRUCTIONS + JSON_TRANSPORT_GUIDE;
  const contract = modelContract(payload, instructions);
  assert.ok(!contract.includes(JSON_TRANSPORT_GUIDE));
  assert.equal((instructions + contract).split(JSON_TRANSPORT_GUIDE).length - 1, 1);
  for (const text of ['not json', 'null', '42', 'true', '[]', '{}']) assert.equal(modelContract(text), '');
  const unknown = modelContract(JSON.stringify({ retrievalFinalization: true }));
  assert.ok(!unknown.includes(JSON_TRANSPORT_GUIDE));
});

test('approved paths and snippets remain byte-exact decoded values with ordinary JSON escaping', () => {
  const slash = String.fromCharCode(92), crlf = String.fromCharCode(13, 10);
  const source = 'const quoted = "' + slash + 'value";' + crlf + 'next();' + crlf;
  const payload = { file: { id: 'approved', path: 'C:' + slash + 'src' + slash + 'file.js',
    left: { text: source }, right: { text: source } } };
  const before = structuredClone(payload), wire = JSON.stringify(payload);
  const instructions = REVIEW_INSTRUCTIONS;
  const contract = modelContract(wire, instructions);
  assert.ok(contract.includes(JSON_TRANSPORT_GUIDE));
  assert.deepEqual(payload, before); assert.equal(wire, JSON.stringify(before));
  const decoded = JSON.parse(modelJson(wire));
  assert.deepEqual(decoded, payload);
  assert.ok(Buffer.from(decoded.file.right.text).equals(Buffer.from(source)));
  assert.ok(!contract.includes(source));
  const finalized = modelContract(JSON.stringify({ ...payload, retrievalFinalization: true }), instructions);
  assert.ok(finalized.includes(JSON_TRANSPORT_GUIDE)); assert.match(finalized, /禁止requests/);
});

test('strict modelJson still rejects bad escapes raw multiline strings trailing commas and smart quotes', () => {
  const slash = String.fromCharCode(92);
  const invalid = [
    '{"text":"' + slash + 'q"}',
    '{"text":"line' + String.fromCharCode(10) + 'break"}',
    '{"text":"value",}',
    '{“text”:“value”}',
    '{"text":"' + slash + 'u12xz"}',
  ];
  for (const wire of invalid) assert.throws(() => modelJson(wire), error => error.code === 'MODEL_INVALID_JSON');
  assert.equal(JSON.parse(modelJson(JSON.stringify({ text: slash + 'q' }))).text, slash + 'q');
});
