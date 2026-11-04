import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { apply } from '../index.mjs';
import { createReviewService } from '../src/service.mjs';
import { buildMigrationContracts } from '../src/migration-contracts.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { buildCoveragePlan } from '../src/coverage-plan.mjs';
import { REVIEW_INSTRUCTIONS } from '../src/review.mjs';

const flags = ['enableMigrationContracts', 'enableMigrationRegression', 'enableGroupInteractions', 'enableStageContinuation'];
const policies = value => Object.fromEntries(flags.map(flag => [flag, value]));
const snapshot = (count = 1) => ({ id: 'complete-policy', vcs: 'git', root: '/repo', context: [], files: Array.from({ length: count }, (_, i) => ({ id: 'f' + i, path: i ? 'test/a.test.js' : 'src/a.js', eligibility: 'reviewable', properties: [], left: { text: 'guard();\n' }, right: { text: 'unsafe();\n' } })) });
const exec = cwd => ({ agent: { session: { header: { id: 'policy-owner', cwd: cwd ?? '/repo' } }, options: { provider: 'offline', model: 'fixture' } }, signal: new AbortController().signal });
const empty = () => ({ findings: [], limitations: [], risks: [] });
const llm = fn => ({ async *stream(wire) { const p = JSON.parse(wire.messages[0].content[0].text), value = fn(p); yield { type: 'text-delta', text: JSON.stringify(value) }; yield { type: 'finish', reason: { kind: 'stop' } }; } });
const settings = { allowModelSending: true, authorize: async () => true, changesConcurrency: 1, optimizeReviewCalls: true };

for (const enabled of [false, true]) test('service preview exposes all four explicit policy booleans and every changed flag invalidates resume: ' + enabled, async t => {
  let sends = 0, saved;
  const model = llm(() => { sends++; return empty(); });
  const options = { ...settings, capture: async () => snapshot(), ...(enabled ? policies(true) : {}) };
  const service = createReviewService(model, options); t.after(() => service.dispose());
  const e = exec(); e.reviewResumeCheckpoint = async state => { saved = state; };
  const preview = await service.preview({}, e); assert.equal(sends, 0);
  for (const flag of flags) assert.equal(preview.execution[flag], enabled);
  const result = await service.execute({ previewId: preview.previewId, confirmed: true }, e);
  assert.equal(result.report.modelCalls, 1); assert.equal(sends, 1); assert.equal(saved.completed.length, 1);
  assert.equal(saved.schemaVersion, enabled ? 2 : 1);
  e.resolveReviewResume = async () => saved;
  for (const flag of flags) {
    const changed = createReviewService(model, { ...options, [flag]: !enabled }); t.after(() => changed.dispose());
    await assert.rejects(changed.preview({ resumeFromJobId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }, e), /identity mismatch|Invalid stage resume checkpoint/);
  }
  assert.equal(sends, 1);
});

test('actual plugin production defaults enable all policies and explicit config false reaches preview without model sends', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'ocr-policy-')); t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  git('init'); git('config', 'user.email', 'offline@example.invalid'); git('config', 'user.name', 'Offline fixture');
  await writeFile(join(cwd, 'a.js'), 'guard();\n'); git('add', 'a.js'); git('commit', '-m', 'fixture'); await writeFile(join(cwd, 'a.js'), 'unsafe();\n');
  for (const enabled of [true, false]) {
    const definitions = []; let dispose, sends = 0;
    apply({ tools: { register: value => definitions.push(value) }, llm: { stream() { sends++; throw new Error('preview must not send'); } }, on(event, fn) { assert.ok(['dispose','llm/stream'].includes(event)); if (event === 'dispose') dispose = fn; } }, enabled ? {} : policies(false));
    try {
      const output = await definitions.find(tool => tool.name === 'code_review_preview').execute({}, exec(cwd));
      const preview = JSON.parse(output.json); for (const flag of flags) assert.equal(preview.execution[flag], enabled);
      assert.equal(sends, 0); assert.equal(preview.modelSendingEnabled, true);
    } finally { dispose(); }
  }
});

test('group preview discloses conditional savings and retained dedicated fallback cost before actual evidence is known', async t => {
  let sends = 0;
  const service = createReviewService(llm(p => { sends++; return p.sourceMode === 'group-primary' ? { reviews: p.reviews.map(row => ({ fileId: row.fileId, findings: [], limitations: [] })), limitations: [], interactions: { groupId: p.groupId, findings: [], limitations: [] } } : empty(); }), { ...settings, capture: async () => snapshot(2), enableGroupPrimary: true, enableGroupInteractions: true }); t.after(() => service.dispose());
  const e = exec(), preview = await service.preview({}, e);
  assert.equal(sends, 0); assert.equal(preview.plan.minimumCalls, 1); assert.equal(preview.plan.primaryGroups[0].interactionChannel, 'conditional');
  assert.equal(preview.plan.interactions[0].minimumCalls, 0); assert.equal(preview.plan.interactions[0].fallbackMinimumCalls, 1);
  assert.match(preview.plan.interactions[0].notice, /missing\/invalid channel retains its fallback cost/);
  const result = await service.execute({ previewId: preview.previewId, confirmed: true }, e);
  assert.equal(result.report.modelCalls, 2); assert.equal(sends, 2); assert.equal(result.report.interactions[0].status, 'completed');
  assert.equal(result.report.groupInteractionChannels[0].status, 'fallback'); assert.equal(result.report.groupInteractionChannels[0].groupId, preview.plan.primaryGroups[0].groupId);
});

function migrationSnapshot() {
  const fn = (name, body) => 'export function ' + name + '(state) {\n' + body + '\n}\n';
  const caller = 'import { mutate } from "./public.mjs";\n' + fn('run', '  mutate(state);');
  return { id: 'migration-policy', vcs: 'git', root: '/repo', context: [], files: [
    ['a', 'public.mjs', fn('mutate', '  if (!state.allowed) { return; }\n  state.value++;'), fn('mutate', '  state.value++;')],
    ['b', 'preload.mjs', fn('preload', '  state.ready = true;'), 'import { mutate } from "./public.mjs";\n' + fn('preload', '  if (!state.allowed) { return; }\n  mutate(state);')],
    ['c', 'caller.mjs', caller, caller],
  ].map(([id, path, old, fresh]) => ({ id, path, eligibility: 'reviewable', properties: [], left: { text: old }, right: { text: fresh } })) };
}

test('migration preview uses the actual producer with approved source IDs and no reader consumption or model sends', async t => {
  const input = migrationSnapshot(), root = createRetrievalScope(input), before = root.usage();
  const plan = buildCoveragePlan(input, { instructions: REVIEW_INSTRUCTIONS, scope: root, maxInputBytes: 98304, enableMigrationContracts: true });
  assert.deepEqual(root.usage(), before); assert.equal(plan.migrationContracts.contracts.length, 1);
  assert.deepEqual(plan.migrationContracts.contracts, buildMigrationContracts(input).contracts);
  const catalog = root.catalog(); for (const role of [...plan.migrationContracts.contracts[0].old, ...plan.migrationContracts.contracts[0].new]) { assert.equal(catalog.find(source => source.id === role.sourceId).fileId, role.fileId); }
  let sends = 0;
  const service = createReviewService(llm(() => { sends++; return empty(); }), { ...settings, capture: async () => input, enableMigrationContracts: true }); t.after(() => service.dispose());
  const e = exec(), preview = await service.preview({}, e); assert.equal(sends, 0);
  const result = await service.execute({ previewId: preview.previewId, confirmed: true }, e);
  assert.deepEqual(preview.plan.migrationContracts, result.report.migrationContracts); assert.equal(result.report.retrievalUsage.calls, 0);
  assert.deepEqual(preview.plan.interactions.map(group => group.fileIds), result.report.interactions.map(group => group.fileIds));
});

test('actual grouped migration prompt carries approved navigation with preview call parity and no extra source authority', async t => {
  const input = migrationSnapshot(); input.files[2].right.text += '// changed caller metadata' + String.fromCharCode(10);
  const expected = buildMigrationContracts(input), approved = createRetrievalScope(input).catalog();
  const prompts = [];
  const service = createReviewService(llm(p => {
    prompts.push(p);
    if (p.sourceMode !== 'group-primary') return empty();
    assert.equal(p.migrationContracts.length, 1); assert.deepEqual(p.migrationContracts, expected.contracts);
    assert.match(p.migrationNotice, /Host navigation hypotheses only/); assert.match(p.migrationNotice, /Neither semantics nor causality/); assert.match(p.migrationNotice, /independent verification/);
    assert.deepEqual(p.catalog, approved); assert.deepEqual(p.retrieved, []);
    for (const contract of p.migrationContracts) {
      assert.equal(contract.causality, 'unverified'); assert.equal(contract.status, 'navigation-only');
      for (const role of [...contract.old, ...contract.new]) { const source = p.catalog.find(source => source.id === role.sourceId); assert.ok(source); assert.equal(source.fileId, role.fileId); assert.equal(source.side, role.side); }
    }
    return { reviews: p.reviews.map(row => ({ fileId: row.fileId, findings: [], limitations: [] })), limitations: [] };
  }), { ...settings, capture: async () => input, enableMigrationContracts: true, enableGroupPrimary: true }); t.after(() => service.dispose());
  const e = exec(), preview = await service.preview({}, e);
  assert.equal(prompts.length, 0); assert.equal(preview.plan.primaryGroups.length, 1);
  const result = await service.execute({ previewId: preview.previewId, confirmed: true }, e);
  assert.equal(result.report.modelCalls, preview.plan.minimumCalls); assert.equal(prompts.filter(p => p.sourceMode === 'group-primary').length, 1);
  assert.deepEqual(preview.plan.migrationContracts, result.report.migrationContracts); assert.equal(result.report.retrievalUsage.calls, 0); assert.equal(result.report.retrievalUsage.outputBytes, 0);
});

test('accepted primary checkpoint preview removes generation calls but discloses and executes fresh independent verification', async t => {
  let primary = 0, verifier = 0, saved, failVerification = true;
  const finding = { fileId: 'f0', severity: 'high', title: 'Missing guard', evidence: 'unsafe invocation', trigger: 'bad state', impact: 'invalid state', suggestion: 'restore guard', anchor: { kind: 'line', side: 'new', start: 1, end: 1, snippet: 'unsafe();' }, attribution: { editIds: ['e1'], properties: [], beforeBehavior: 'guarded', afterBehavior: 'unsafe', reason: 'guard removed' } };
  const model = llm(p => {
    if (p.candidates) { verifier++; if (failVerification) throw new Error('offline verifier interruption'); const receipt = p.retrieved.find(item => item.result.receiptId); assert.ok(receipt); return { verdicts: [{ candidateId: 'c1', verdict: 'refuted', reason: 'Fresh independent counterevidence', evidence: [{ receiptId: receipt.result.receiptId }] }] }; }
    primary++; return { findings: [finding], limitations: [] };
  });
  const service = createReviewService(model, { ...settings, capture: async () => snapshot(), enableStageContinuation: true }); t.after(() => service.dispose());
  const e = exec(); e.reviewResumeCheckpoint = async state => { saved = state; };
  const first = await service.preview({}, e), result = await service.execute({ previewId: first.previewId, confirmed: true }, e);
  assert.equal(result.report.status, 'partial'); assert.equal(primary, 1); assert.equal(verifier, 1); assert.equal(saved.schemaVersion, 2); assert.equal(saved.completed.length, 0); assert.equal(saved.stageGenerations.length, 1);
  assert.doesNotMatch(JSON.stringify(saved), /receiptId|retrievalAudit/);
  e.resolveReviewResume = async () => saved; failVerification = false;
  const resumed = await service.preview({ resumeFromJobId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }, e);
  assert.equal(resumed.resume.reusableFiles, 0); assert.equal(resumed.resume.reusableGenerations, 1); assert.deepEqual(resumed.resume.stageFileIds, ['f0']);
  assert.equal(resumed.plan.minimumCalls, 0); assert.equal(resumed.plan.items[0].freshVerificationRequired, true); assert.equal(resumed.plan.items[0].reusedGenerations, 1); assert.match(resumed.resume.notice, /fresh independent receipts/);
  const completed = await service.execute({ previewId: resumed.previewId, confirmed: true }, e);
  assert.equal(primary, 1); assert.equal(verifier, 2); assert.equal(completed.report.modelCalls, 1); assert.equal(completed.report.findings[0].verification.verdict, 'refuted'); assert.equal(completed.report.status, 'completed');
});
