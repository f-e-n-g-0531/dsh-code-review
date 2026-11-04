import test from 'node:test';

test('project preserves batch scope notice text and file ownership without rewriting partial history', () => {
  const notice = { fileId: 'a', text: '按需读取，不声明全部上下文已核查。' };
  const make = status => renderProjectReport({ status, files: [{ fileId: 'a', path: 'a.mjs', status: 'completed' }], findings: [], coverage: { total: 1, completed: 1 }, batches: [{ scopeNotices: [notice], limitations: [] }] });
  const completed = make('completed');
  assert.ok(completed.includes('范围说明'));
  assert.ok(completed.includes(notice.text));
  assert.ok(completed.includes('a.mjs'));
  assert.ok(completed.includes('所选范围已查完'));
  assert.ok(make('partial').includes('尚未查完'));
  const merged = renderProjectReport({ status: 'completed', files: [{ fileId: 'a', path: 'a.mjs', status: 'completed' }], findings: [], scopeNotices: [notice], batches: [{ scopeNotices: [notice] }] });
  assert.ok(merged.includes('范围说明：1 项'));
  assert.ok(!merged.includes('范围说明：2 项'));
});
import assert from 'node:assert/strict';import {renderProjectReport} from '../src/project-report.mjs';test('project emits one report instead of concatenated batch reports',()=>{const r=renderProjectReport({snapshotId:'s',status:'partial',coverage:{total:2,completed:2,excluded:0,blocked:0,pending:0},files:[{path:'a',status:'completed',stageFailures:[{phase:'window-synthesis',code:'MODEL_INVALID_JSON'}]}],findings:[],batches:[{interactions:[],limitations:[{text:'synthesis missing'}]},{interactions:[],limitations:[]}]});assert.equal((r.match(/# 全项目代码审查报告/g)||[]).length,1);assert.ok(!r.includes('## 批次'));assert.ok(r.includes('window-synthesis'));});
