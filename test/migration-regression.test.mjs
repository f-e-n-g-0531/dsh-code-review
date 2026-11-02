import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { createEvidenceReceipts } from '../src/evidence-receipts.mjs';
import { validateCandidateVerification } from '../src/candidate-verification.mjs';
import { validateRegressionAssessment } from '../src/regression-assessment.mjs';
import { prepareMigrationRegression, migrationRegressionMetadata } from '../src/migration-regression.mjs';
import { verificationLoop } from '../src/verification-loop.mjs';
import { reviewSnapshot } from '../src/review.mjs';
import { buildMigrationContracts } from '../src/migration-contracts.mjs';
const file = (id, old, current) => ({ id, path: id + '.js', eligibility: 'reviewable', left: { text: old }, right: { text: current }, properties: [] });
function setup() {
 const snapshot = { id: 'migration-snap', context: [], files: [file('A', 'export function Public() { guard(); mutate(); }\n', 'export function Public() { mutate(); }\n'), file('B', 'export function Preload() { return; }\n', 'import { Public } from "./A.js"; export function Preload() { Public(); mutate(); }\n'), file('C', 'import { Public } from "./A.js"; Public();\n', 'import { Public } from "./A.js"; Public();\n')] };
 const scope = createRetrievalScope(snapshot, { reuseResults: true });
 const catalog = scope.catalog(), source = (id, side) => catalog.find(source => source.fileId === id && source.side === side);
 const role = (id, side) => ({ sourceId: source(id, side).id, fileId: id, path: id + '.js', side, line: 1, symbol: id === 'A' ? 'Public' : 'Preload', editIds: ['e1'] });
 const contract = { id: 'mc1', snapshotId: snapshot.id, status: 'navigation-only', causality: 'unverified', candidateFileIds: ['A', 'B'], old: [role('A', 'old')], new: [role('B', 'new')], callers: [{ sourceId: source('C', 'old').id, fileId: 'C', path: 'C.js', side: 'old', line: 1, importLine: 1, targetFileId: 'A', targetSymbol: 'Public', editIds: [] }] };
 const candidate = { fileId: 'B', anchor: { kind: 'line', side: 'new', start: 1, end: 1, snippet: 'mutate' }, attribution: { status: 'references-validated', editIds: ['e1'] } };
 return { snapshot, scope, catalog, contract, candidate, source };
}
const regression = patch => ({ classification: 'introduced', reason: 'public guard moved away from still-called entry', oldEvidence: [0], newEvidence: [1], migrationContractId: 'mc1', ...patch });
function verified(f, patch = {}, refs) {
 const receipts = createEvidenceReceipts(f.scope.read);
 const values = refs ?? [f.source('A', 'old').id, f.source('B', 'new').id, f.source('C', 'old').id].map(id => ({ receiptId: receipts.read({ id, start: 1, count: 1 }).receiptId }));
 const context = prepareMigrationRegression(f.snapshot, f.scope, [f.contract], [f.candidate]);
 const verdict = { candidateId: 'c1', verdict: 'supported', reason: 'approved migrated entry comparison', evidence: values, regression: regression(patch) };
 const validate = () => validateCandidateVerification({ verdicts: [verdict] }, ['c1'], f.scope.read, receipts.resolve, { enableMigrationRegression: true, migrationContext: context, catalog: f.catalog, fileIds: { c1: 'B' } });
 return { validate, verdict, context, receipts };
}

test('old public guard A and new mutation B compare only through host-bound contract and independent receipts', () => {
 const f = setup(), { validate } = verified(f); const result = validate()[0];
 assert.equal(result.regression.classification, 'introduced'); assert.equal(result.regression.migrationContractId, 'mc1'); assert.equal(result.regression.migrationSnapshotId, f.snapshot.id);
 assert.equal(result.regression.status, 'comparison-references-validated'); assert.equal(result.regression.causality, 'unverified'); assert.ok(result.evidence.every(item => item.status === 'references-validated'));
});

test('default four-key same-primary comparison remains strict and optional ID never enables itself', () => {
 const f = setup(), r = verified(f); const { migrationContractId, ...legacy } = r.verdict.regression;
 r.verdict.regression = legacy; assert.throws(r.validate, /side or primary mismatch/);
 assert.throws(() => validateRegressionAssessment(regression(), [], f.catalog, 'B'), /not enabled/);
 r.verdict.regression = regression();
 assert.throws(() => validateCandidateVerification({ verdicts: [r.verdict] }, ['c1'], f.scope.read, r.receipts.resolve, { catalog: f.catalog, fileIds: { c1: 'B' } }), /not enabled/);
});

test('neither caller-only nor missing edge nor wrong role source can satisfy introduced migration', () => {
 for (const patch of [{ oldEvidence: [] }, { newEvidence: [] }, { oldEvidence: [2] }, { oldEvidence: [1] }, { newEvidence: [0] }, { newEvidence: [2] }, { oldEvidence: [0, 0] }, { newEvidence: [99] }, { migrationContractId: 'model-invented' }]) assert.throws(verified(setup(), patch).validate);
 const f = setup(), r = verified(f, { oldEvidence: [0, 2] }); assert.equal(r.validate()[0].regression.classification, 'introduced');
});

test('uncertain migration does not invent missing edges; present wrong-side and unapproved refs still fail', () => {
 const result = verified(setup(), { classification: 'uncertain', oldEvidence: [], newEvidence: [] }).validate()[0];
 assert.equal(result.regression.classification, 'uncertain'); assert.equal(result.regression.causality, 'unverified');
 assert.throws(verified(setup(), { classification: 'uncertain', oldEvidence: [1], newEvidence: [] }).validate);
});

test('host compiler rejects missing sides incorrect snapshot source path edit identities and missing caller chain', () => {
 const mutations = [f => { f.contract.snapshotId = 'other'; }, f => { f.contract.old = []; }, f => { f.contract.new = []; }, f => { f.contract.old[0].sourceId = f.source('A', 'new').id; }, f => { f.contract.new[0].path = 'other.js'; }, f => { f.contract.new[0].editIds = ['forged']; }, f => { f.contract.new[0].editIds = []; }, f => { f.contract.callers = []; }, f => { f.contract.callers[0].targetFileId = 'foreign'; }, f => { f.contract.candidateFileIds = ['C']; }, f => { f.contract.callers[0].line = 999; }];
 for (const mutate of mutations) { const f = setup(); mutate(f); assert.throws(() => prepareMigrationRegression(f.snapshot, f.scope, [f.contract], [f.candidate]), /Invalid approved migration/); }
 const f = setup(); assert.throws(() => prepareMigrationRegression(f.snapshot, f.scope, [f.contract, f.contract], [f.candidate]), /Invalid approved migration/);
});

test('candidate must own an exact changed edit at its anchor; arbitrary cross-file candidate cannot borrow contract', () => {
 for (const mutate of [f => { f.candidate.fileId = 'C'; }, f => { f.candidate.attribution.status = 'missing'; }, f => { f.candidate.attribution.editIds = ['foreign']; }, f => { f.candidate.anchor.start = 80; f.candidate.anchor.end = 80; }, f => { f.candidate.anchor.side = 'old'; }]) { const f = setup(); mutate(f); assert.throws(verified(f).validate); }
});

test('copied contract metadata cannot mint a host capability and prior receipt is never current evidence', () => {
 const f = setup(), r = verified(f), metadata = migrationRegressionMetadata(r.context);
 assert.ok(Object.isFrozen(r.context)); assert.throws(() => { r.context.contracts[0].new.sourceId = 'forged'; }, TypeError);
 assert.equal(metadata[0].status, 'navigation-only'); metadata[0].new[0].sourceId = 'forged'; assert.equal(migrationRegressionMetadata(r.context)[0].new[0].sourceId, f.source('B', 'new').id);
 assert.throws(() => validateCandidateVerification({ verdicts: [r.verdict] }, ['c1'], f.scope.read, r.receipts.resolve, { enableMigrationRegression: true, migrationContext: structuredClone(r.context), catalog: f.catalog, fileIds: { c1: 'B' } }), /Invalid approved migration/);
 const fresh = createEvidenceReceipts(f.scope.read); assert.throws(() => validateCandidateVerification({ verdicts: [r.verdict] }, ['c1'], f.scope.read, fresh.resolve, { enableMigrationRegression: true, migrationContext: r.context, catalog: f.catalog, fileIds: { c1: 'B' } }), /Invalid evidence receipt/);
 const forged = structuredClone(r.verdict); forged.evidence[0] = { ...forged.evidence[0], text: 'guard' }; assert.throws(() => validateCandidateVerification({ verdicts: [forged] }, ['c1'], f.scope.read, r.receipts.resolve, { enableMigrationRegression: true, migrationContext: r.context, catalog: f.catalog, fileIds: { c1: 'B' } }), /Invalid evidence receipt/);
});

test('baseline context caller uses only explicit context-old lineage, never target-side substitution', () => {
 const f = setup();
 f.snapshot.history = { base: 'base', target: 'target' };
 f.snapshot.context = [{ path: 'external.js', text: 'import { Preload } from "./B.js"; Preload();\n', oldText: 'import { Public } from "./A.js"; Public();\n', revision: 'target', oldRevision: 'base' }];
 f.scope = createRetrievalScope(f.snapshot); f.catalog = f.scope.catalog();
 const oldCaller = f.catalog.find(source => source.side === 'context-old');
 f.contract.callers = [{ sourceId: oldCaller.id, side: oldCaller.side, path: oldCaller.path, line: 1, importLine: 1, editIds: [], targetFileId: 'A', targetSymbol: 'Public' }];
 const r = verified(f); const receipt = r.receipts.read({ id: oldCaller.id, start: 1, count: 1 }); r.verdict.evidence.push({ receiptId: receipt.receiptId }); r.verdict.regression.oldEvidence = [0, 3];
 assert.equal(r.validate()[0].regression.migrationContractId, 'mc1');
 const current = f.catalog.find(source => source.side === 'context');
 f.contract.callers = [{ ...f.contract.callers[0], sourceId: current.id, side: current.side }];
 assert.throws(() => prepareMigrationRegression(f.snapshot, f.scope, [f.contract], [f.candidate]), /Invalid approved migration/);
});

test('candidate contract identity stays per-candidate even for multiple candidates in one primary file', () => {
 const f = setup(), other = { ...f.candidate, attribution: { status: 'missing' } };
 const context = prepareMigrationRegression(f.snapshot, f.scope, [f.contract], [other, f.candidate]);
 const r = verified(f), options = { enableMigrationRegression: true, migrationContext: context, catalog: f.catalog, fileIds: { c1: 'B', c2: 'B' } };
 const valid = { ...r.verdict, candidateId: 'c2' };
 assert.equal(validateCandidateVerification({ verdicts: [valid] }, ['c2'], f.scope.read, r.receipts.resolve, options)[0].regression.migrationContractId, 'mc1');
 assert.throws(() => validateCandidateVerification({ verdicts: [r.verdict] }, ['c1'], f.scope.read, r.receipts.resolve, options), /Invalid approved migration/);
});

test('wrong snapshot or tampered approved body cannot satisfy a compiled role even with valid-looking catalog IDs', () => {
 const f = setup(), r = verified(f), alternate = setup(); alternate.snapshot.id = 'other';
 const scope = createRetrievalScope(alternate.snapshot); const receipts = createEvidenceReceipts(scope.read);
 r.verdict.evidence = [f.source('A', 'old').id, f.source('B', 'new').id].map(id => ({ receiptId: receipts.read({ id, start: 1, count: 1 }).receiptId }));
 assert.throws(() => validateCandidateVerification({ verdicts: [r.verdict] }, ['c1'], scope.read, receipts.resolve, { enableMigrationRegression: true, migrationContext: r.context, catalog: scope.catalog(), fileIds: { c1: 'B' } }), /Invalid approved migration/);
});

test('verificationLoop displays only host-bound contracts and uses fresh current receipts for both migration edges', async () => {
 const f = setup(); let turns = 0;
 const result = await verificationLoop(async request => {
  const input = JSON.parse(request.input); turns++;
  assert.equal(input.snapshotId, f.snapshot.id); assert.equal(input.migrationContracts[0].id, 'mc1');
  if (turns === 1) return { requests: [f.source('A', 'old').id, f.source('B', 'new').id, f.source('C', 'old').id].map(id => ({ kind: 'read', id, start: 1, count: 1 })) };
  const refs = [f.source('A', 'old').id, f.source('B', 'new').id, f.source('C', 'old').id].map(id => ({ receiptId: input.retrieved.find(item => item.result.sourceId === id).result.receiptId }));
  return { verdicts: [{ candidateId: 'c1', verdict: 'supported', reason: 'migration mismatch', evidence: refs, regression: regression() }] };
 }, { instructions: 'host', input: JSON.stringify({ snapshotId: f.snapshot.id, migrationContracts: [{ id: 'forged-model-input' }] }), signal: new AbortController().signal }, [f.candidate], f.scope, { enableMigrationRegression: true, migrationContracts: [f.contract], migrationSnapshot: f.snapshot, maxRounds: 3 });
 assert.equal(turns, 2); assert.equal(result[0].regression.migrationContractId, 'mc1'); assert.equal(result[0].regression.causality, 'unverified');
});

test('project current-source mode does not expose migration contract or accept migration comparison ID', async () => {
 const f = setup(); f.snapshot.projectScope = { mode: 'current-source' }; assert.throws(() => prepareMigrationRegression(f.snapshot, f.scope, [f.contract], [f.candidate]), /Invalid approved migration/);
 const model = async request => { const input = JSON.parse(request.input); assert.equal(input.migrationContracts, undefined); return { verdicts: [{ candidateId: 'c1', verdict: 'uncertain', reason: 'not regression mode', evidence: [], regression: regression({ classification: 'uncertain', oldEvidence: [], newEvidence: [] }) }] }; };
 await assert.rejects(verificationLoop(model, { instructions: 'host', input: JSON.stringify({ snapshotId: f.snapshot.id, file: { reviewMode: 'project' } }) }, [f.candidate], f.scope, { enableMigrationRegression: true, migrationContracts: [f.contract], migrationSnapshot: f.snapshot, maxRounds: 0 }), /not enabled/);
});


test('actual review pipeline keeps default primary comparison strict and enables only host-produced migrated roles with fresh receipts', async () => {
 const publicOld = 'export function Public(state) {\n  if (!state.allowed) { return; }\n  state.value++;\n}\n';
 const publicNew = 'export function Public(state) {\n  state.value++;\n}\n';
 const preloadOld = 'export function Preload(state) {\n  state.ready = true;\n}\n';
 const preloadNew = 'import { Public } from "./A.js";\nexport function Preload(state) {\n  if (!state.allowed) { return; }\n  Public(state);\n}\n';
 const caller = 'import { Public } from "./A.js";\nexport function Run(state) {\n  Public(state);\n}\n';
 const snapshot = { id: 'actual-migration-review', root: '/repo', vcs: 'git', context: [], files: [file('A', publicOld, publicNew), file('B', preloadOld, preloadNew), file('C', caller, caller)] };
 const contracts = buildMigrationContracts(snapshot).contracts; assert.equal(contracts.length, 1);
 const contract = contracts[0], oldRole = contract.old[0], newRole = contract.new[0];
 const finding = { fileId: 'B', severity: 'high', title: 'Old public entry remains unguarded after migration', evidence: 'Guard exists only in preloader', trigger: 'Caller still invokes Public', impact: 'Mutation bypasses the preloader guard', suggestion: 'Keep guard on all public mutation routes', anchor: { kind: 'line', side: 'new', start: newRole.line, end: newRole.line, snippet: preloadNew.split('\n')[newRole.line - 1] }, attribution: { editIds: [...newRole.editIds], properties: [], beforeBehavior: 'Public checks allowed', afterBehavior: 'Only preloader checks allowed', reason: 'Guard relocation leaves old route exposed' } };
 async function run(enabled, forged = false) {
  const seen = [];
  const report = await reviewSnapshot(structuredClone(snapshot), request => {
   const payload = JSON.parse(request.input); seen.push({ request, payload });
   if (request.reviewPhase === 'verification') {
    const bound = payload.migrationContracts;
    if (enabled) { assert.equal(bound[0].id, contract.id); assert.equal(payload.snapshotId, snapshot.id); } else assert.equal(bound, undefined);
    const wanted = [oldRole.sourceId, newRole.sourceId];
    const missing = wanted.filter(id => !payload.retrieved.some(item => item.result.sourceId === id));
    if (missing.length) return { requests: missing.map(id => ({ kind: 'read', id, start: id === oldRole.sourceId ? oldRole.line : newRole.line, count: 1 })) };
    const refs = wanted.map(id => payload.retrieved.find(item => item.result.sourceId === id).result);
    assert.ok(refs.every(ref => typeof ref.receiptId === 'string')); assert.ok(refs.every(ref => ref.snapshotId === snapshot.id));
    const comparison = regression({ reason: 'Old Public guard and new Preload guard refer to the explicit migration contract' });
    if (enabled) comparison.migrationContractId = bound[0].id; else delete comparison.migrationContractId;
    return { verdicts: [{ candidateId: payload.candidates[0].candidateId, verdict: 'supported', reason: 'Current independent reads confirm entry mismatch', evidence: refs.map(ref => ({ receiptId: forged ? 'prior-stage-foreign-receipt' : ref.receiptId })), regression: comparison }] };
   }
   if (payload.file?.id === 'B') return { findings: [finding], limitations: [] };
   return { findings: [], limitations: [], risks: [] };
  }, { enableRetrieval: true, enableVerification: true, enableMigrationContracts: true, enableMigrationRegression: enabled, enableRiskPlanning: false, enableGrouping: false, enableGroupPrimary: false, enablePrimarySeeds: false, focusPrimaryContext: false, changesConcurrency: 1, maxRetrievalRounds: 3 });
  return { report, seen };
 }
 // Model does not propose an ID when disabled: the original same-file comparator
 // itself rejects old A/new B, rather than merely rejecting the optional field.
 const off = await run(false), on = await run(true), forged = await run(true, true);
 assert.equal(off.report.findings.length, 1); assert.equal(off.report.findings[0].verification.status, 'incomplete');
 assert.ok(off.report.limitations.some(item => /side or primary mismatch/.test(item.text)), JSON.stringify(off.report.limitations));
 assert.equal(on.report.findings.length, 1); assert.equal(on.report.findings[0].verification.status, 'completed', JSON.stringify(on.report.limitations));
 assert.equal(on.report.findings[0].verification.regression.migrationContractId, contract.id); assert.equal(on.report.findings[0].verification.regression.causality, 'unverified');
 assert.equal(on.report.migrationContracts.contracts[0].id, contract.id); assert.equal(on.report.findings[0].verification.evidence.length, 2);
 assert.equal(forged.report.findings[0].verification.status, 'incomplete'); assert.ok(forged.report.limitations.some(item => /Invalid evidence receipt/.test(item.text)));
 const reads = on.seen.filter(item => item.request.reviewPhase === 'verification').flatMap(item => item.payload.retrieved);
 assert.ok(reads.some(item => item.result.sourceId === oldRole.sourceId)); assert.ok(reads.some(item => item.result.sourceId === newRole.sourceId));
});
