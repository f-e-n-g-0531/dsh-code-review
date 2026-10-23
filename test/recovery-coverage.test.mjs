import test from 'node:test';import assert from 'node:assert/strict';import {recoveryCoverage} from '../src/recovery-coverage.mjs';test('saved windows never claim file complete and unfinished paths require new approval',()=>{const r=recoveryCoverage({checkpoints:[{stage:'file-started',path:'a',status:'pending'},{stage:'window-complete',path:'a',windowCoverage:{completed:['h1'],pending:['h2']}},{stage:'file-complete',file:{path:'b',status:'completed'}}]});assert.deepEqual(r.suggestedPaths,['a']);assert.equal(r.files.find(f=>f.path==='a').status,'pending');assert.equal(r.windows[0].pending[0],'h2');});

test('approved manifest keeps unstarted files in recovery denominator',()=>{const r=recoveryCoverage({checkpoints:[{stage:'approved-manifest',snapshotId:'approved',files:[{path:'a',status:'pending'},{path:'b',status:'pending'}]},{stage:'file-complete',file:{path:'a',status:'completed'}}]});assert.equal(r.manifestSaved,true);assert.equal(r.files.length,2);assert.deepEqual(r.suggestedPaths,['b']);});

test('completed primary with failed synthesis remains unfinished follow-up scope',()=>{const r=recoveryCoverage({checkpoints:[{stage:'file-complete',file:{path:'a',status:'completed'}},{stage:'synthesis-failed',path:'a',phase:'window-synthesis',status:'failed',code:'MODEL_INVALID_JSON'}]});assert.deepEqual(r.suggestedPaths,['a']);assert.equal(r.unfinishedStages.length,1);assert.equal(r.files[0].status,'completed');});

test('file-started preserves blocked and excluded eligibility while reviewable stays pending', () => {
  const result = recoveryCoverage({ checkpoints: ['blocked', 'excluded', 'reviewable'].map((status, i) => ({ stage: 'file-started', path: String(i), status })) });
  assert.deepEqual(result.files.map(file => file.status), ['blocked', 'excluded', 'pending']);
  assert.deepEqual(result.suggestedPaths, ['0', '2']);
});
