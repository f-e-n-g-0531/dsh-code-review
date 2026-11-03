import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewDiagnostics, diagnosticsMarkdown } from '../src/review-diagnostics.mjs';

test('migration seed diagnostics count host delivery attempts without exposing source or identities', () => {
  const report = { files: [{ migrationSeedEvents: [
    { kind: 'old-delegation', status: 'accepted', source: 'PRIVATE', contractId: 'SECRET' },
    { kind: 'old-delegation', status: 'fallback', reason: 'FINAL_RESERVE' },
    { kind: 'SECRET', status: 'fallback', reason: 'INPUT_CAPACITY' },
    { kind: 'deleted-export-route', status: 'accepted' },
    { kind: 'SECRET', status: 'accepted' },
    { kind: 'old-delegation', status: 'SECRET' },
  ] }] };
  const frozen = structuredClone(report);
  const d = reviewDiagnostics(report);
  assert.deepEqual(d.migrationSeeds, [
    { kind: 'old-delegation', status: 'accepted', count: 1 },
    { kind: 'old-delegation', status: 'fallback', count: 1 },
    { kind: 'deleted-export-route', status: 'accepted', count: 1 },
  ]);
  assert.deepEqual(d.migrationSeedReasons, [{ reason: 'FINAL_RESERVE', count: 1 }]);
  assert.deepEqual(report, frozen);
  assert.doesNotMatch(JSON.stringify(d), /PRIVATE|SECRET/);
  const text = diagnosticsMarkdown(d).join('\n');
  assert.match(text, /计预取尝试，不表示模型已调用、复核通过/);
  assert.match(text, /删除导出导航仍仅允许不确定归因/);
});

test('old reports without migration seed events do not invent successful delivery', () => {
  const d = reviewDiagnostics({ files: [] });
  assert.deepEqual(d.migrationSeeds, []);
  assert.doesNotMatch(diagnosticsMarkdown(d).join('\n'), /迁移证据成套预取/);
});
