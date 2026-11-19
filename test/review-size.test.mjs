import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewSize } from '../src/review-size.mjs';
import { renderUserReport } from '../src/user-report.mjs';

test('counts only approved UTF-8 body bytes and measures both context sides', () => {
  const snapshot = { files: [
    {eligibility:'reviewable',left:{text:'旧'},right:{text:'new'}},
    {eligibility:'excluded',left:{text:'asset'},right:{text:'资源'}},
    {eligibility:'blocked',right:{text:'not approved'}},
  ], context:[{text:'context',oldText:'旧上下文'}] };
  assert.deepEqual(reviewSize(snapshot, undefined, {inputBudget:{wireBytes:70},items:[{initialInputBytes:100}]}), {
    unit:'UTF-8 bytes',sourceBytes:6,oldSourceBytes:3,newSourceBytes:3,contextBytes:19,
    sourceFileCount:1,excludedFileCount:1,initialInputBytes:70,initialInputUnits:1,
    modelPayloadInputBytes:null,modelObservedOutputBytes:null,modelMeasuredCalls:0,
  });
});

test('aggregates per-file and shared metrics across batches without merging phase names', () => {
  const phase = (inputBytes,totalOutputBytes) => ({primary:{calls:1,inputBytes,totalOutputBytes}});
  const a = {initialInputBytes:17,modelMetrics:phase(23,11)}, b = {initialInputBytes:19,modelMetrics:phase(29,13)};
  const size = reviewSize({}, {files:[a,b],batches:[{files:[a],orchestration:{modelMetrics:phase(5,3)}},{files:[b]}]});
  assert.equal(size.initialInputBytes,36);
  assert.equal(size.modelPayloadInputBytes,57);
  assert.equal(size.modelObservedOutputBytes,27);
  assert.equal(size.modelMeasuredCalls,3);
  assert.match(renderUserReport({size}), /57\/27 B/);
  assert.doesNotMatch(renderUserReport({size:reviewSize({})}), /已观测的模型输入/);
});
