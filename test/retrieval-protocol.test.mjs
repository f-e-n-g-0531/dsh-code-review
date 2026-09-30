import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRetrievalResponse, executeRetrievalBatch } from '../src/retrieval-protocol.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
const scope = () => createRetrievalScope({ id: 's', files: [], context: [{ path: 'helper', text: 'hello\nworld' }] });
const read = { kind: 'read', id: 's1', start: 1, count: 1 };
test('strict retrieval batch returns provenance without executing arbitrary operations', () => {
  const results = executeRetrievalBatch({ requests: [{ kind: 'search', query: 'world', limit: 1 }, read] }, scope());
  assert.equal(results[0].result.matches[0].line, 2);
  assert.equal(results[1].result.text, 'hello\n');
  assert.equal(results[1].result.snapshotId, 's');
});
test('invalid trailing requests and unknown sources do not partially execute', () => {
  for (const bad of [{ kind: 'shell', command: 'whoami' }, { ...read, path: '/secret' }, { ...read, id: 'unknown' }]) {
    const reader = scope();
    assert.throws(() => executeRetrievalBatch({ requests: [read, bad] }, reader));
    assert.equal(reader.usage().calls, 0);
  }
});
test('batch bounds and mixed final responses are rejected', () => {
  for (const value of [{ requests: [] }, { requests: Array(9).fill(read) }, { requests: [read], findings: [] }, { requests: [{ kind: 'search', query: '\n', limit: 1 }] }, 'x'.repeat(131073)]) assert.throws(() => parseRetrievalResponse(value));
  const controller = new AbortController(); controller.abort();
  const reader = scope();
  assert.throws(() => executeRetrievalBatch({ requests: [read] }, reader, controller.signal));
  assert.equal(reader.usage().calls, 0);
});
