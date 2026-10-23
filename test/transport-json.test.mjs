import test from 'node:test';
import assert from 'node:assert/strict';
import { modelJson } from '../src/model-json.mjs';
const parse = text => modelJson(text, { allowTrailingProse: true });

test('balanced leading JSON with plain trailing prose is returned byte-exact without repairs', () => {
  for (const body of ['{"findings":[],"limitations":[]}', '{"text":"brace } and \\"quote\\"","n":1e3}', '[{"nested":["x"]}]']) {
    assert.equal(parse(body + '\nReview completed.'), body);
    assert.equal(parse(body + '\n审查完成。'), body);
    assert.throws(() => modelJson(body + '\nReview completed.'), e => e.code === 'MODEL_INVALID_JSON');
  }
});

test('ambiguous multiple values nonleading JSON malformed tails and unfinished strings fail closed', () => {
  for (const text of [
    '{} {}', '{} []', '{} true', '{} null', '{} 42', '{} false', '{} "text"',
    '{} Note: {}', '{} Note: [unfinished', '{} }', '{} ,', '{} ;', '{} \u0060\u0060\u0060',
    'Note: {}', 'prefix {"findings":[]}', '{"text":"unterminated}', '{"x":1,} Note',
    '{"x":"bad' + String.fromCharCode(92) + 'q"} Note',
    '\u0060\u0060\u0060json\n{}\n\u0060\u0060\u0060 trailing',
  ]) assert.throws(() => parse(text), e => e.code === 'MODEL_INVALID_JSON', text);
});

test('exact plain JSON and exact fences retain existing behavior and no values are normalized', () => {
  const raw = '{"number":1e3,"text":"\\u4e2d"}';
  assert.equal(parse(raw), raw);
  assert.equal(parse('\u0060\u0060\u0060json\n' + raw + '\n\u0060\u0060\u0060'), raw);
});
