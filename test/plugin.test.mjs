import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, inject } from '../index.mjs';
test('plugin registers canonical review and durable task tools without executable shell capabilities', () => {
  const definitions = [];
  let dispose; const events = [];
  apply({ tools: { register: def => definitions.push(def) }, llm: {}, approval: {}, on: (event, fn) => { events.push(event); if (event === 'dispose') dispose = fn; else assert.equal(event, 'llm/stream'); } });
  assert.deepEqual(inject, ['tools', 'llm']);
  assert.ok(events.includes('llm/stream'));
  assert.deepEqual(definitions.map(d => d.name), ['review_snapshot', 'code_review_preview', 'code_review_execute','code_review_start','code_review_status','code_review_cancel','code_review_wait','code_review_artifacts']);
  for (const def of definitions.filter(def => def.name !== 'review_snapshot')) {
    assert.equal(def.parameters.additionalProperties, false);
    assert.deepEqual(def.output.schema.required, ['json', 'markdown']);
    assert.deepEqual(def.output.render({}, { json: '{}', markdown: '' }), [{ type: 'text', text: '{}' }]);
  }
  assert.deepEqual(definitions[0].output.schema.required, ['json']);
  dispose();
});
