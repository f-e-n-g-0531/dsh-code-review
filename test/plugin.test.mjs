import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, inject } from '../index.mjs';
test('plugin registers two canonical tools without new executable capabilities', () => {
  const definitions = [];
  let dispose;
  apply({ tools: { register: def => definitions.push(def) }, llm: {}, approval: {}, on: (event, fn) => { assert.equal(event, 'dispose'); dispose = fn; } });
  assert.deepEqual(inject, ['tools', 'llm']);
  assert.deepEqual(definitions.map(d => d.name), ['code_review_preview', 'code_review_execute']);
  for (const def of definitions) {
    assert.equal(def.parameters.additionalProperties, false);
    assert.deepEqual(def.output.schema.required, ['json', 'markdown']);
    assert.deepEqual(def.output.render({}, { json: '{}', markdown: '' }), [{ type: 'text', text: '{}' }]);
  }
  dispose();
});
