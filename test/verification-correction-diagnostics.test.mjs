import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewDiagnostics, diagnosticsMarkdown } from '../src/review-diagnostics.mjs';
test('verification batch correction cost is visible without source text',()=>{
 const d=reviewDiagnostics({files:[{modelCallPurposes:{'verification-correction':1},modelCorrections:[{action:'verification-response-correction',code:'MODEL_INCOMPLETE_VERIFICATION',source:'PRIVATE'}]}]});
 assert.deepEqual(d.modelCallPurposes,[{purpose:'verification-correction',calls:1}]);
 assert.ok(d.correctionReasons.some(r=>r.code==='MODEL_INCOMPLETE_VERIFICATION'&&r.calls===1));
 assert.ok(!JSON.stringify(d).includes('PRIVATE'));
 assert.match(diagnosticsMarkdown(d).join('\n'),/复核批次纠正/);
});
