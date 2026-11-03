import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMigrationContracts } from '../src/migration-contracts.mjs';
import { prepareMigrationRegression, migrationRegressionMetadata, validateMigrationRegression } from '../src/migration-regression.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { createEvidenceReceipts } from '../src/evidence-receipts.mjs';
import { validateCandidateVerification } from '../src/candidate-verification.mjs';

function fixture() {
  const header = (name, method, fields = '') => 'class ' + name + ' {\npublic:\n  void ' + method + ';\n' + fields + '};\n';
  const old = '#include "Plugin.h"\n#include "Preloader.h"\nvoid Plugin::Load(Preloader& loader, int value) {\n  if (value < 0) { return; }\n  loader.Load(value);\n}\n';
  const current = '#include "Plugin.h"\nvoid Plugin::Load(Preloader& loader, int value) {\n  shared = value;\n  if (value < 0) { return; }\n}\n';
  const baseline = '#include "Preloader.h"\nvoid Preloader::Load(int value) {\n  shared = value;\n  if (value < 0) { return; }\n}\n';
  const files = [['plugin', 'Plugin.cpp', old, current], ['preload', 'Preloader.cpp', baseline, baseline]].map(([id, path, before, after]) =>
    ({ id, path, eligibility: 'reviewable', properties: [], left: { text: before }, right: { text: after } }));
  const context = [['Plugin.h', header('Plugin', 'Load(Preloader& loader, int value)', '  int shared;\n')], ['Preloader.h', header('Preloader', 'Load(int value)', '  int shared;\n')]]
    .map(([path, text]) => ({ path, text, oldText: text, oldRevision: 'base', revision: 'target' }));
  return { id: 'entry-routes', files, context, history: { base: 'base', target: 'target' } };
}

function setup(snapshot = fixture()) {
  const output = buildMigrationContracts(snapshot), contract = output.contracts.find(c => c.kind === 'old-delegation');
  assert.ok(contract);
  const scope = createRetrievalScope(snapshot), receipts = createEvidenceReceipts(scope.read);
  const role = contract.new[0];
  const candidate = { fileId: 'plugin', anchor: { kind: 'line', side: 'new', start: role.line, end: role.line }, attribution: { status: 'references-validated', editIds: role.editIds } };
  const context = prepareMigrationRegression(snapshot, scope, [contract], [candidate]);
  const refs = [contract.old[0], contract.new[0], contract.baseline[0]].map(role => ({ receiptId: receipts.read({ id: role.sourceId, start: role.startLine, count: role.endLine - role.startLine + 1 }).receiptId }));
  const verdict = { candidateId: 'c1', verdict: 'supported', reason: 'guard no longer precedes shared-state write on public route', evidence: refs,
    regression: { classification: 'introduced', reason: 'old route guards before delegation, new route writes first', oldEvidence: [0, 2], newEvidence: [1], migrationContractId: contract.id } };
  const validate = () => validateCandidateVerification({ verdicts: [verdict] }, ['c1'], scope.read, receipts.resolve,
    { enableMigrationRegression: true, migrationContext: context, catalog: scope.catalog(), fileIds: { c1: 'plugin' } });
  return { snapshot, output, contract, scope, receipts, context, verdict, validate };
}

test('old guarded Plugin to old preloader and new write-before-guard route retain all three independent roles', () => {
  const f = setup();
  assert.deepEqual(f.contract.candidateFileIds, ['plugin']);
  assert.equal(f.contract.old[0].fileId, f.contract.new[0].fileId);
  assert.equal(f.contract.baseline[0].fileId, 'preload');
  assert.equal(f.contract.baseline[0].symbol, 'Preloader::Load');
  assert.match(f.contract.unresolved[0], /syntax-only/);
  assert.equal(migrationRegressionMetadata(f.context)[0].baseline.length, 1);
  assert.equal(f.validate()[0].regression.causality, 'unverified');
  assert.ok(f.output.groups.some(g => g.fileIds.includes('preload')));
});

test('entry-only declaration-only and wrong-side evidence cannot establish old path comparison', () => {
  for (const change of [
    f => { f.verdict.regression.oldEvidence = [0]; },
    f => { f.verdict.regression.oldEvidence = [2]; },
    f => { f.verdict.regression.oldEvidence = [0, 1]; },
    f => { const r = f.contract.baseline[0]; f.verdict.evidence[2] = { receiptId: f.receipts.read({ id: r.sourceId, start: r.startLine, count: 1 }).receiptId }; },
    f => { const r = f.contract.new[0]; f.verdict.evidence[1] = { receiptId: f.receipts.read({ id: r.sourceId, start: r.line, count: 1 }).receiptId }; },
  ]) { const f = setup(); change(f); assert.throws(f.validate); }
  const f = setup(); f.verdict.regression = { ...f.verdict.regression, classification: 'uncertain', oldEvidence: [], newEvidence: [] };
  assert.equal(f.validate()[0].regression.classification, 'uncertain');
});

test('old implementation may be historical approved context but never current-only context', () => {
  const s = fixture(), preloader = s.files.pop();
  s.context.push({ path: preloader.path, text: preloader.right.text, oldText: preloader.left.text, revision: 'target', oldRevision: 'base' });
  const f = setup(s); assert.equal(f.contract.baseline[0].side, 'context-old'); assert.equal(f.validate()[0].regression.classification, 'introduced');
  delete s.context.at(-1).oldText;
  assert.equal(buildMigrationContracts(s).contracts.length, 0);
});

test('same names without old literal include typed receiver or unique definition never bind', () => {
  for (const change of [
    s => { s.files[0].left.text = s.files[0].left.text.replace('#include "Preloader.h"', ''); },
    s => { s.files[0].left.text = s.files[0].left.text.replace('loader.Load(value);', 'other.Load(value);'); },
    s => { s.files[0].left.text = s.files[0].left.text.replace('loader.Load(value);', '// loader.Load(value);'); },
    s => { s.files.push({ ...s.files[1], id: 'duplicate', path: 'Other.cpp' }); },
    s => { s.context[1].oldText = s.context[1].oldText.replace('Load(int value);', 'Load(int value);\n  void Load(bool value);'); },
    s => { s.files[0].right.text = s.files[0].right.text.replace('Plugin::Load', 'Other::Load'); },
  ]) { const s = fixture(); change(s); assert.equal(buildMigrationContracts(s).contracts.length, 0); }
});

test('split current-generation receipts cover a complete baseline without a declaration-only shortcut', () => {
  const f = setup(), role = f.contract.baseline[0];
  f.verdict.evidence[2] = { receiptId: f.receipts.read({ id: role.sourceId, start: role.startLine, count: 2 }).receiptId };
  f.verdict.evidence.push({ receiptId: f.receipts.read({ id: role.sourceId, start: role.startLine + 2, count: role.endLine - role.startLine - 1 }).receiptId });
  f.verdict.regression.oldEvidence = [0, 2, 3];
  assert.equal(f.validate()[0].regression.classification, 'introduced');
});

test('guard-first repair remains navigation only and host never declares a regression from name or body equality', () => {
  const s = fixture(); s.files[0].right.text = s.files[0].right.text.replace('  shared = value;\n  if (value < 0) { return; }', '  if (value < 0) { return; }\n  shared = value;');
  const f = setup(s);
  assert.equal(f.contract.status, 'navigation-only'); assert.equal(f.contract.causality, 'unverified');
  assert.equal(f.contract.classification, undefined);
  f.verdict.regression.classification = 'preexisting';
  assert.equal(f.validate()[0].regression.classification, 'preexisting');
});

test('old-delegation compiler independently rebuilds roles and rejects model-supplied widening', () => {
  for (const change of [
    c => { c.baseline[0].sourceId = c.new[0].sourceId; },
    c => { c.baseline = []; },
    c => { c.old[0].symbol = 'Other::Load'; },
    c => { c.new[0].endLine--; },
    c => { c.callers[0].targetFileId = 'foreign'; },
    c => { c.candidateFileIds.push('preload'); },
  ]) { const f = setup(), contract = structuredClone(f.contract); change(contract); assert.throws(() => prepareMigrationRegression(f.snapshot, f.scope, [contract], [])); }
});

// Exact inert entry bodies from seq117/104/82, never executed or compiled.
function exportedFixture() {
  return { id: 'actual-export', context: [], files: [
    ['plugin', 'Plugin.cpp', "extern \"C\" C3APP_FRAMEWORK_API bool PreloadResource_RolePart(const char* pszPartName, PARTID idPart, DWORD dwLife)\n{\n\tif ((!pszPartName) || (!pszPartName[0]))\n\t{\n\t\treturn false;\n\t}\n\n\tconst RolePartInfo* pRolePartInfo = g_objGameDataSet.GetRoleRartInfo(pszPartName, idPart);\n\tif (pRolePartInfo)\n\t{\n\t\tfor (int i = 0; i < pRolePartInfo->nPart; i++)\n\t\t{\n\t\t\tC3DObj* p3DObj = g_objGameDataSet.Get3DObj(pRolePartInfo->idMesh[i], 0, dwLife, RESOURCE_LOADING_PRIORITY_SUPREME);\n\t\t\tC3DTexture* p3DTexture = g_objGameDataSet.Get3DTexture(pRolePartInfo->idTexture[i], 0, dwLife, RESOURCE_LOADING_PRIORITY_SUPREME);\n\t\t}\n\t}\n\n\t//S3部件不支持预加载\n\tstring strTempPartName = pszPartName;\n\tC3AutoConfigManager::GetAutoConfigPartName(strTempPartName);\n\n\tstring strResPack;\n\tstring strResFile;\n\tif (C3AutoConfigManager::GetInstance()->GetAutoConfig_C3Model(strTempPartName.c_str(), idPart, strResPack, strResFile))\n\t{\n\t\tRolePartPreloader::GetInstance()->Preload(strTempPartName.c_str(), idPart, dwLife);\n\t\treturn true;\n\t}\n\n\treturn false;\n}", ''],
    ['lower', 'ResourceLoader/RolePartPreloader.cpp', "void RolePartPreloader::Preload(const char* pszPartName, PARTID idPart, DWORD dwLife)\n{\n\tm_dwLife = dwLife;\n\tPreload(pszPartName, idPart);\n}\n\nvoid RolePartPreloader::Preload(const char* pszPartName, PARTID idPart)\n{\n\tIC3ConfigExLoader* pC3ConfigExLoader = g_objGameDataSet.GetC3ConfigExLoader();\n\tif (!pC3ConfigExLoader)\n\t{\n\t\treturn;\n\t}\n\tGAME_MODEL_TYPE rolePartType = GAME_MODEL_TYPE_NONE;\n\tbool bHasLoaded = false;\n\tPARTID rolePartRealID = idPart;\n\tpC3ConfigExLoader->LoadConfigEx_Model(pszPartName, idPart, this, rolePartType, bHasLoaded, rolePartRealID);\n}", ''],
    ['current', 'C3ResourcesManager/C3ResourcePreloader.cpp', '', "bool C3ResourcePreloader::PreloadRolePart(const char* pszPartName, PARTID idPart)\n{\n    GAME_MODEL_TYPE modelType = GAME_MODEL_TYPE_NONE;\n    bool bHasLoaded = false;\n    PARTID nRealIdPart = idPart;\n    return GetResourceLoadCoordinator().LoadConfigEx_Model(pszPartName, idPart, this, modelType, bHasLoaded, nRealIdPart);\n}\n\nbool C3ResourcePreloader::PreloadRolePart(const char* pszPartName, PARTID idPart, DWORD dwLife)\n{\n    m_dwLife = dwLife;\n    CHECKF(pszPartName && pszPartName[0])\n\n    PreloadRegisteredRolePart(pszPartName, idPart);\n    return PreloadRolePart(pszPartName, idPart);\n}"]
  ].map(([id, path, before, after]) => ({ id, path, eligibility: 'reviewable', properties: [], left: { text: before }, right: { text: after } })) };
}

test('actual deleted export singleton overload and differently named entry deliver three independent roles', () => {
  const s = exportedFixture(), out = buildMigrationContracts(s), c = out.contracts.find(c => c.kind === 'deleted-export-route');
  assert.ok(c, JSON.stringify(out.limitations));
  assert.equal(c.old[0].symbol, 'PreloadResource_RolePart');
  assert.equal(c.baseline[0].symbol, 'RolePartPreloader::Preload');
  assert.equal(c.new[0].symbol, 'C3ResourcePreloader::PreloadRolePart');
  const call = c.callers[0];
  assert.match(s.files.find(f => f.id === call.fileId).left.text.split('\n')[call.callLine - 1], /RolePartPreloader::GetInstance\(\)->Preload/);
  const scope = createRetrievalScope(s), role = c.new[0];
  for (const r of [c.old[0], c.baseline[0], role]) assert.ok(scope.read({ id: r.sourceId, start: r.startLine, count: r.endLine - r.startLine + 1 }));
  const candidate = { fileId: 'current', anchor: { kind: 'line', side: 'new', start: role.line, end: role.line }, attribution: { status: 'references-validated', editIds: role.editIds } };
  const ctx = prepareMigrationRegression(s, scope, [c], [candidate]);
  assert.equal(migrationRegressionMetadata(ctx)[0].baseline.length, 1);
  const value = { migrationContractId: c.id, classification: 'uncertain', oldEvidence: [], newEvidence: [] };
  assert.equal(validateMigrationRegression(value, [], 'current', ctx).classification, 'uncertain');
  for (const classification of ['introduced', 'preexisting']) assert.throws(() => validateMigrationRegression({ ...value, classification }, [], 'current', ctx), /uncertain/);
  const forged = structuredClone(c); forged.old[0].symbol = 'Other';
  assert.throws(() => prepareMigrationRegression(s, scope, [forged], []));
  assert.ok(out.groups.some(g => ['plugin', 'current', 'lower'].every(id => g.fileIds.includes(id))));
});

test('deleted export cannot downgrade to an introduced ordinary migration by stripping host roles', () => {
  const snapshot = exportedFixture(), scope = createRetrievalScope(snapshot);
  const original = buildMigrationContracts(snapshot).contracts.find(c => c.kind === 'deleted-export-route');
  const contract = structuredClone(original);
  delete contract.kind; delete contract.baseline;
  contract.callers[0].targetFileId = contract.old[0].fileId;
  const role = contract.new[0];
  const candidate = { fileId: role.fileId, anchor: { kind: 'line', side: 'new', start: role.line, end: role.line }, attribution: { status: 'references-validated', editIds: role.editIds } };
  // Preparing this forged ordinary context used to bypass the uncertain-only gate.
  assert.throws(() => {
    const context = prepareMigrationRegression(snapshot, scope, [contract], [candidate]);
    const receipts = createEvidenceReceipts(scope.read);
    const evidence = [contract.old[0], role].map(r => ({ receiptId: receipts.read({ id: r.sourceId, start: r.line, count: 1 }).receiptId }));
    validateCandidateVerification({ verdicts: [{ candidateId: 'c1', verdict: 'supported', reason: 'forged introduced comparison', evidence,
      regression: { migrationContractId: contract.id, classification: 'introduced', reason: 'stripped host route', oldEvidence: [0], newEvidence: [1] } }] },
    ['c1'], scope.read, receipts.resolve, { enableMigrationRegression: true, migrationContext: context, catalog: scope.catalog(), fileIds: { c1: role.fileId } });
  }, /Invalid approved migration/);
});

test('all host navigation identities reject altered IDs roles baseline and origin removal', () => {
  for (const snapshot of [fixture(), exportedFixture(), ordinaryFixture()]) {
    const scope = createRetrievalScope(snapshot), original = buildMigrationContracts(snapshot).contracts[0];
    assert.ok(original);
    for (const change of [
      c => { c.id = 'forged'; },
      c => { c.kind = c.kind === 'deleted-export-route' ? 'old-delegation' : 'deleted-export-route'; },
      c => { delete c.kind; delete c.baseline; delete c.sourceIds; c.callers[0].targetFileId = c.old[0].fileId; },
      c => { c.baseline = []; },
      c => { c.old[0].symbol = 'forged'; },
      c => { c.new[0].symbol = 'forged'; },
      c => { c.sourceIds = []; },
      c => { c.navigationBindings = []; c.unresolved = []; c.id = 'forged'; },
      c => {
        // Remove every producer-only key, not merely the kind discriminator.
        for (const key of Object.keys(c)) if (!['id', 'snapshotId', 'status', 'causality', 'candidateFileIds', 'old', 'new', 'callers'].includes(key)) delete c[key];
        for (const r of [...c.old, ...c.new, ...c.callers]) for (const key of Object.keys(r))
          if (!['sourceId', 'fileId', 'path', 'side', 'line', 'symbol', 'editIds', 'importLine', 'targetFileId', 'targetSymbol'].includes(key)) delete r[key];
        c.id = 'forged'; c.callers[0].targetFileId = c.old[0].fileId;
      },
    ]) {
      const contract = structuredClone(original); change(contract);
      assert.throws(() => prepareMigrationRegression(snapshot, scope, [contract], []), /Invalid approved migration/);
    }
    // JSON property order is not identity; a plain transport round-trip is legal.
    const reordered = Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(original))).reverse());
    assert.equal(migrationRegressionMetadata(prepareMigrationRegression(snapshot, scope, [reordered], [])).length, 1);
  }
});

function ordinaryFixture() {
  const fn = (name, body) => 'export function ' + name + '(state) {\n' + body + '\n}\n';
  return { id: 'ordinary', context: [], files: [
    ['a', 'public.mjs', fn('mutate', '  if (!state.allowed) { return; }\n  state.value++;'), fn('mutate', '  state.value++;')],
    ['b', 'preload.mjs', fn('preload', '  state.ready = true;'), 'import { mutate } from "./public.mjs";\n' + fn('preload', '  mutate(state);')],
    ['c', 'caller.mjs', 'import { mutate } from "./public.mjs";\n' + fn('run', '  mutate(state);'), ''],
  ].map(([id, path, before, after]) => ({ id, path, eligibility: 'reviewable', properties: [], left: { text: before }, right: { text: after } })) };
}

test('contract and candidate data never execute getters inherited hooks or proxy traps', () => {
  const snapshot = exportedFixture(), scope = createRetrievalScope(snapshot), original = buildMigrationContracts(snapshot).contracts[0];
  for (const locate of [c => [c, 'kind'], c => [c, 'baseline'], c => [c.old[0], 'symbol'], c => [c.callers[0], 'targetFileId'], c => [c, 'toJSON']]) {
    const contract = structuredClone(original), [object, key] = locate(contract);
    let calls = 0;
    Object.defineProperty(object, key, { get() { calls++; throw new Error('getter ran'); }, enumerable: true });
    assert.throws(() => prepareMigrationRegression(snapshot, scope, [contract], []), /Invalid approved migration/);
    assert.equal(calls, 0);
  }
  let calls = 0;
  const contract = structuredClone(original);
  Object.setPrototypeOf(contract, { get kind() { calls++; return 'old-delegation'; } });
  assert.throws(() => prepareMigrationRegression(snapshot, scope, [contract], []), /Invalid approved migration/);
  const candidates = [{}];
  Object.defineProperty(candidates[0], 'fileId', { get() { calls++; return 'current'; }, enumerable: true });
  assert.throws(() => prepareMigrationRegression(snapshot, scope, [original], candidates), /Invalid approved migration/);
  const contracts = new Proxy([original], { get() { calls++; throw new Error('proxy ran'); } });
  assert.throws(() => prepareMigrationRegression(snapshot, scope, contracts, []), /Invalid approved migration/);
  assert.equal(calls, 0);
});

test('unsupported or ambiguous actual export navigation reports the missing old public entry', () => {
  for (const change of [
    s => { s.files.push({ ...s.files[2], id: 'duplicate', path: 'Unrelated.cpp' }); },
    s => { s.files[1].left.text = ''; },
    s => { s.files[0].left.text = s.files[0].left.text.replace('RolePartPreloader::GetInstance()->Preload', 'Other::GetInstance()->Preload'); },
    s => { s.files[2].right.text = s.files[2].right.text.replace('m_dwLife = dwLife;', 'other = dwLife;'); },
    s => { s.files[0].left.text = '#if SOMETHING\n' + s.files[0].left.text + '#endif\n'; },
  ]) {
    const s = exportedFixture(); change(s); const out = buildMigrationContracts(s);
    assert.equal(out.contracts.length, 0);
    assert.ok(out.limitations.some(l => /old public (?:entry|export)/i.test(l)), JSON.stringify(out.limitations));
  }
});
