import test from 'node:test';import assert from 'node:assert/strict';import {jobProgress} from '../src/job-progress.mjs';test('capture has unknown percent and terminal file processing is not successful coverage',()=>{const r={status:'running',stage:'capture',createdAt:new Date().toISOString(),checkpoints:[]};assert.equal(jobProgress(r).percent,null);r.checkpoints=[{stage:'approved-manifest',files:[{path:'a',status:'pending'},{path:'b',status:'pending'}]},{stage:'file-complete',file:{path:'a',status:'failed'}}];assert.equal(jobProgress(r).percent,50);assert.equal(jobProgress(r).counts.completed,0);});

test('finished jobs freeze elapsed time at finishedAt and clamp negative intervals', () => {
  const record = { status: 'completed', stage: 'complete', createdAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01.234Z' };
  assert.equal(jobProgress(record).elapsedMs, 1234);
  assert.equal(jobProgress({ ...record, finishedAt: record.createdAt }).elapsedMs, 0);
  assert.equal(jobProgress({ ...record, finishedAt: '2025-01-01T00:00:00Z' }).elapsedMs, 0);
});

test('blocked starts are terminal processing but not successful review', () => {
  const record = { status: 'running', stage: 'file-started', createdAt: new Date().toISOString(), checkpoints: [
    { stage: 'approved-manifest', files: [{ path: 'a', status: 'blocked' }, { path: 'b', status: 'pending' }] },
    { stage: 'file-started', path: 'a', status: 'blocked' },
  ] };
  const progress = jobProgress(record);
  assert.equal(progress.counts.blocked, 1);
  assert.equal(progress.counts.pending, 1);
  assert.equal(progress.counts.completed, 0);
  assert.equal(progress.percent, 50);
});
