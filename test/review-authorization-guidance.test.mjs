import test from 'node:test';
import assert from 'node:assert/strict';
import {apply} from '../index.mjs';

test('tool guidance treats matching explicit review request as authorization, not a second user message', async () => {
  const defs = [], disposes = [];
  apply({tools:{register:d=>defs.push(d)},llm:{},on:(_e,f)=>disposes.push(f)});
  try {
    const tool = name => defs.find(d=>d.name===name);
    assert.match(tool('code_review_preview').description, /inspect the preview internally/);
    assert.match(tool('code_review_preview').description, /without asking the user to confirm the same review again/);
    assert.match(tool('code_review_preview').description, /preview only/);
    for (const name of ['code_review_execute','code_review_start']) {
      const d = tool(name);
      assert.match(d.description, /authorized scope|scope.model.destination/);
      assert.match(d.parameters.properties.confirmed.description, /explicit|explicitly/);
      assert.match(d.parameters.properties.confirmed.description, /Preview-only/);
      assert.match(d.description, /wait.for.confirmation|wait for confirmation/);
      assert.match(d.parameters.properties.confirmed.description, /wait-for-confirmation/);
    }
    assert.match(tool('code_review_wait').description, /without asking again/);
    assert.match(tool('code_review_wait').description, /preview-only, explicit wait-for-confirmation or out-of-authorization/);
    assert.match(tool('code_review_artifacts').description, /obtain user consent/);
    assert.ok(tool('code_review_execute').parameters.required.includes('confirmed'));
  } finally { for (const dispose of disposes) await dispose(); }
});
