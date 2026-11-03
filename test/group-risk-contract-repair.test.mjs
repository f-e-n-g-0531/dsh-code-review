import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareGroupPrimary, validateGroupPrimary, GROUP_PRIMARY_INSTRUCTIONS } from '../src/group-primary.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { REVIEW_INSTRUCTIONS, reviewSnapshot, validateFindings } from '../src/review.mjs';

const snapshot = () => ({ id: 'group-risk-contract', vcs: 'git', context: [], files: ['a', 'b'].map(id => ({ id, path: id + '.js', eligibility: 'reviewable', properties: [], left: { text: 'guard();\n' }, right: { text: 'unsafe();\n' } })) });
const finding = () => ({ fileId: 'a', severity: 'high', title: 'Guard removed', evidence: 'unsafe operation', trigger: 'invalid input', impact: 'invalid state', suggestion: 'restore guard', anchor: { kind: 'line', side: 'new', start: 1, end: 1, snippet: 'unsafe();' }, attribution: { editIds: ['e1'], properties: [], beforeBehavior: 'guarded', afterBehavior: 'unguarded', reason: 'guard removed' } });
const response = () => ({ reviews: ['a', 'b'].map(fileId => ({ fileId, findings: fileId === 'a' ? [finding()] : [], limitations: [], risks: [] })), limitations: [] });
function fixture(enabled = true) {
  const input = snapshot(), scope = createRetrievalScope(input);
  const prepared = prepareGroupPrimary(input, { id: 'g1', fileIds: ['a', 'b'] }, { instructions: REVIEW_INSTRUCTIONS, scope, maxInputBytes: 98304, enableRiskPlanning: enabled });
  assert.ok(prepared);
  return { input, scope, prepared, check: value => validateGroupPrimary(value, prepared, input, validateFindings, scope.catalog()) };
}
const risk = () => ({ id: 'r1', fileIds: ['a', 'b'], editRefs: [{ fileId: 'a', editId: 'e1' }, { fileId: 'b', editId: 'e1' }], question: 'Can both guards be removed?', trigger: 'invalid input', impact: 'invalid state', checks: ['Inspect callers and counterevidence'], sourceIds: [] });

test('enabled prompt puts required risks in each member schema, never top level or optional', () => {
  const { prepared } = fixture();
  const schema = JSON.parse(prepared.instructions.slice(prepared.instructions.indexOf('返回 {"reviews":') + 3).split('，')[0]);
  assert.deepEqual(schema.reviews[0].risks, []);
  assert.equal(Object.hasOwn(schema, 'risks'), false);
  assert.match(prepared.instructions, /每个reviews成员必须包含risks字段/);
  assert.match(prepared.instructions, /没有真实风险或精确编辑时返回risks:\[\]/);
  assert.match(prepared.instructions, /不要.*编造风险/);
  assert.match(prepared.instructions, /Exactly these 8 keys, all required/);
  assert.match(prepared.instructions, /不是证据、缺陷或扩大范围\/读取权限的授权/);
  assert.match(prepared.instructions, /sourceIds不证明已读/);
  assert.doesNotMatch(prepared.instructions, /optional risks|omit risks|可附带risks/);
});

test('disabled prompt and validation do not require risk planning', () => {
  const f = fixture(false), value = response();
  for (const row of value.reviews) delete row.risks;
  assert.equal(f.prepared.instructions, REVIEW_INSTRUCTIONS + '\n' + GROUP_PRIMARY_INSTRUCTIONS);
  assert.equal(f.prepared.inlineRisk, false);
  assert.doesNotMatch(f.prepared.instructions, /risks/);
  const validated = f.check(value);
  assert.equal(validated.get('a').findings.length, 1);
  assert.ok([...validated.values()].every(row => row.groupRisk === undefined));
});

test('empty member risks complete without invented hypotheses', () => {
  const f = fixture(), value = response(), validated = f.check(value);
  for (const row of validated.values()) assert.deepEqual(row.groupRisk, { status: 'completed', risks: [] });
});

test('valid cross-member edit references remain unverified hypotheses, not new findings', () => {
  const f = fixture(), value = response(); value.reviews[1].risks = [risk()];
  const validated = f.check(value), accepted = validated.get('b').groupRisk;
  assert.equal(accepted.status, 'completed');
  assert.equal(accepted.risks[0].status, 'hypothesis');
  assert.equal(accepted.risks[0].causality, 'unverified');
  assert.deepEqual(validated.get('b').findings, []);
  assert.equal(validated.get('a').findings.length, 1);
});

const malformed = [
  ['null', null], ['object', {}], ['bad shape', [{ bad: true }]],
  ['unknown member', [{ ...risk(), fileIds: ['outside'] }]],
  ['unknown edit', [{ ...risk(), editRefs: [{ fileId: 'a', editId: 'foreign' }] }]],
  ['unknown source', [{ ...risk(), sourceIds: ['not-in-catalog'] }]],
  ['extra authority', [{ ...risk(), verified: true }]],
];
for (const [name, risks] of malformed) test('malformed risk ' + name + ' preserves valid member findings', () => {
  const f = fixture(), value = response(); value.reviews[0].risks = risks;
  const before = structuredClone(value), validated = f.check(value);
  assert.equal(validated.get('a').findings.length, 1);
  assert.deepEqual(validated.get('a').groupRisk, { status: 'invalid', risks: [] });
  assert.equal(validated.get('b').groupRisk.status, 'completed');
  assert.deepEqual(value, before);
});

test('top-level risks cannot fill missing member risks or suppress absent status', () => {
  const f = fixture(), value = response();
  for (const row of value.reviews) delete row.risks;
  value.risks = [risk()];
  const validated = f.check(JSON.stringify(value));
  assert.ok([...validated.values()].every(row => row.groupRisk.status === 'absent'));
  assert.equal(validated.get('a').findings.length, 1);
});

const options = { enableRetrieval: true, enableBusinessGrouping: true, enableGroupPrimary: true, enableRiskPlanning: true, skipSmallRiskPlans: true, enableGrouping: false, changesConcurrency: 1, correctProtocol: true };
for (const mode of ['empty', 'missing', 'invalid', 'top-level', 'disabled']) test('controlled pipeline ' + mode + ' retains findings without hidden planning or correction', async () => {
  const phases = [];
  const report = await reviewSnapshot(snapshot(), request => {
    phases.push(request.reviewPhase);
    if (request.reviewPhase === 'file-interaction') return { findings: [], limitations: [] };
    assert.equal(request.reviewPhase, 'group-primary');
    assert.equal(JSON.parse(request.input).sourceMode, 'group-primary');
    const value = response();
    if (mode === 'invalid') value.reviews[0].risks = [{ bad: true }];
    if (['missing', 'top-level', 'disabled'].includes(mode)) for (const row of value.reviews) delete row.risks;
    if (mode === 'top-level') value.risks = [risk()];
    return value;
  }, { ...options, enableRiskPlanning: mode !== 'disabled' });
  assert.deepEqual(phases, ['group-primary', 'file-interaction']);
  assert.equal(report.modelCalls, 2);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].fileId, 'a');
  assert.equal(report.coverage.completed, 2);
  assert.ok(report.files.every(file => file.status === 'completed' && file.responseCorrections === undefined));
  assert.equal(report.status, ['empty', 'disabled'].includes(mode) ? 'completed' : 'partial');
  if (mode === 'disabled') assert.ok(report.files.every(file => !file.riskPlans?.length));
  else {
    const expected = mode === 'empty' ? 'completed' : mode === 'invalid' ? 'invalid' : 'absent';
    assert.equal(report.files.find(file => file.fileId === 'a').riskPlans[0].status, expected);
    if (expected !== 'completed') assert.ok(report.limitations.some(item => item.text.includes('未补发规划调用')));
  }
});
