import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { retrievalLoop, retrievalRequest } from '../src/retrieval-loop.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { createEvidenceReceipts } from '../src/evidence-receipts.mjs';
import { modelWireBudget } from '../src/model-wire-budget.mjs';
import { preparePrimaryInput } from '../src/primary-input.mjs';
import { prepareGroupPrimary } from '../src/group-primary.mjs';
import { prepareInteractionInput } from '../src/interaction-input.mjs';
import { reviewSnapshot } from '../src/review.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const bytes = req => req.nativeOutputTools ? modelWireBudget(req, 1000000).bytes : Buffer.byteLength(req.input) + Buffer.byteLength(req.instructions);
function fixture() {
  const text = 'unchanged '.repeat(1200) + '\r\n';
  const files = ['a', 'b'].map(id => ({ id, path: id + '.js', eligibility: 'reviewable', properties: [], left: { text: text + 'before();\r\n', hash: hash(text + 'before();\r\n'), revision: 'old' }, right: { text: text + 'after();\r\n', hash: hash(text + 'after();\r\n'), revision: 'new' } }));
  return { id: 'snap', vcs: 'git', history: { base: 'old', target: 'new' }, files, context: [{ path: 'helper.js', text: 'helper '.repeat(1500) + '\r\n', oldText: 'old helper '.repeat(1000) + '\r\n', revision: 'new', oldRevision: 'old', contextSide: 'new', contextVersion: 'target' }], rules: [{ text: 'preserve the task' }], businessRequirement: 'Preserve behavior and inspect callers' };
}
function prepare(kind, snapshot, scope) {
  const options = { instructions: 'Review all original edits; risks and caller claims are hypotheses.', scope, maxInputBytes: 1000000, enableRiskPlanning: false };
  let req;
  if (kind === 'group-primary') {
    const p = prepareGroupPrimary(snapshot, { id: 'g', fileIds: ['a', 'b'] }, options);
    req = { instructions: p.instructions, input: p.payload };
  } else if (kind === 'file-interaction') {
    const p = prepareInteractionInput(snapshot, { id: 'g', fileIds: ['a', 'b'] }, () => ({ fits: true }));
    req = { instructions: options.instructions, input: p.payload };
  } else {
    const p = preparePrimaryInput(snapshot, snapshot.files[0], options);
    req = { instructions: options.instructions, input: p.payload };
  }
  const p = JSON.parse(req.input);
  p.risks = [{ id: 'r1', question: 'countercheck', text: 'claim text must survive' }];
  p.callerBindings = [{ text: 'caller claim', side: 'old', line: 2 }];
  p.windowIndex = [{ id: 'w1', old: { start: 2, count: 1 }, new: { start: 2, count: 1 } }];
  req.input = JSON.stringify(p);
  return req;
}
function withoutBodies(value) {
  const p = structuredClone(value);
  const stripFile = f => { for (const k of ['left', 'right', 'old', 'new']) if (f?.[k]) delete f[k].text; };
  const stripEnvelope = e => {
    stripFile(e.file);
    for (const k of ['files', 'relatedFiles', 'windows']) e[k]?.forEach(stripFile);
    e.context?.forEach(c => { delete c.text; delete c.oldText; });
  };
  stripEnvelope(p); p.reviews?.forEach(stripEnvelope);
  return p;
}
for (const kind of ['primary', 'group-primary', 'file-interaction']) for (const nativeOutputTools of [false, true]) {
  test(kind + ' retains all read evidence under ' + (nativeOutputTools ? 'native wire' : 'legacy') + ' cap', async () => {
    const snapshot = fixture(), raw = createRetrievalScope(snapshot);
    const receipts = createEvidenceReceipts(raw.read);
    const scope = { ...raw, read: receipts.read };
    const request = { ...prepare(kind, snapshot, scope), nativeOutputTools };
    const base = JSON.parse(request.input), initial = retrievalRequest(request, scope, [], {max:3,remaining:3});
    const maxInputBytes = bytes(initial) + 50;
    const reads = [scope.catalog().find(s => s.fileId === 'a' && s.side === 'old'), scope.catalog().find(s => s.fileId === 'b' && s.side === 'new')].map((s, i) => ({ kind: 'read', id: s.id, start: kind === 'file-interaction' && i === 1 ? 2 : 1, count: kind === 'file-interaction' && i === 1 ? 1 : 2 }));
    const events = [], audit = []; let calls = 0, gates = 0, saved;
    const result = await retrievalLoop(async req => {
      calls++;
      assert.ok(bytes(req) <= maxInputBytes);
      const p = JSON.parse(req.input);
      if (calls === 1) {
        assert.equal(req.input, initial.input);
        assert.equal(scope.usage().calls, 0, 'initial supplied text does not count as independent read');
        return { requests: [reads[0]] };
      }
      assert.match(p.followupSourceNotice, /deferred/);
      assert.match(p.followupSourceNotice, /not independent reads/);
      assert.deepEqual(withoutBodies({ ...base }), Object.fromEntries(Object.entries(p).filter(([k]) => Object.hasOwn(base, k))));
      assert.deepEqual(p.catalog, scope.catalog());
      assert.equal(p.snapshotId, snapshot.id);
      assert.equal(p.retrieved.length, calls - 1);
      for (const item of p.retrieved) {
        assert.equal(item.result.omitted, undefined);
        const resolved = receipts.resolve({ receiptId: item.result.receiptId });
        for (const key of ['snapshotId', 'sourceId', 'hash', 'start', 'count', 'text']) assert.equal(item.result[key], resolved[key]);
      }
      if (calls === 2) { saved = p.retrieved[0]; return { requests: [reads[1]] }; }
      assert.deepEqual(p.retrieved[0], saved, 'earlier retrieved body and receipt remain exact');
      return { findings: [], limitations: ['Supplied fragments do not establish full coverage'] };
    }, { ...request, onProtocolEvent: e => events.push(e) }, scope, { correctProtocol: true, maxInputBytes, maxRounds: 3, beforeCall: () => gates++, onRetrieved: rows => audit.push(...rows) });
    assert.equal(calls, 3); assert.equal(gates, 3); assert.equal(scope.usage().calls, 2); assert.equal(audit.length, 2);
    assert.equal(events.some(e => /omitted|deferred/.test(e.action)), false);
    assert.equal(result.limitations.length, 1);
  });
}

test('small followup stays byte-for-byte uncompressed', async () => {
  const snapshot = fixture(), scope = createRetrievalScope(snapshot), request = prepare('primary', snapshot, scope);
  let calls = 0;
  await retrievalLoop(async req => {
    const p = JSON.parse(req.input);
    if (++calls === 1) return { requests: [{ kind: 'read', id: 's1', start: 2, count: 1 }] };
    assert.equal(p.followupSourceNotice, undefined);
    assert.equal(req.input, retrievalRequest(request, scope, p.retrieved, p.retrievalRounds).input);
    return { findings: [], limitations: [] };
  }, request, scope, { correctProtocol: true, maxInputBytes: 1000000 });
  assert.equal(calls, 2);
});

test('initial oversized source is not rescued by followup compaction', async () => {
  const snapshot = fixture(), scope = createRetrievalScope(snapshot), request = prepare('primary', snapshot, scope);
  let calls = 0;
  await assert.rejects(retrievalLoop(async () => { calls++; }, request, scope, { correctProtocol: true, maxInputBytes: 6000 }), /input budget/);
  assert.equal(calls, 0); assert.equal(scope.usage().calls, 0);
});

test('still oversized evidence is honestly omitted without body, receipt or delivered audit', async () => {
  const snapshot = { id: 's', files: [], context: [{ path: 'big', text: 'x'.repeat(20000) }] }, scope = createRetrievalScope(snapshot);
  const request = { instructions: 'review', input: JSON.stringify({ file: { id: 'f', left: { text: 'a'.repeat(1000) }, right: { text: 'b'.repeat(1000) } }, risks: [{ text: 'keep claim' }] }) };
  let calls = 0; const audit = [], events = [];
  await retrievalLoop(async req => {
    if (++calls === 1) return { requests: [{ kind: 'read', id: 's1', start: 1, count: 1 }] };
    const p = JSON.parse(req.input), r = p.retrieved[0].result;
    assert.equal(r.omitted, true); assert.equal(r.text, undefined); assert.equal(r.receiptId, undefined);
    assert.deepEqual(p.risks, [{ text: 'keep claim' }]);
    return { findings: [], limitations: ['Evidence unavailable'] };
  }, { ...request, onProtocolEvent: e => events.push(e) }, scope, { correctProtocol: true, maxInputBytes: bytes(retrievalRequest(request, scope, [], {max:Number.MAX_SAFE_INTEGER,remaining:Number.MAX_SAFE_INTEGER})) + 100, onRetrieved: r => audit.push(...r) });
  assert.equal(scope.usage().calls, 1); assert.equal(calls, 2); assert.equal(audit.length, 0);
  assert.ok(events.some(e => e.action === 'oversized-retrieval-omitted'));
});

test('cancellation at followup admission neither sends nor publishes retrieved evidence', async () => {
  const snapshot = fixture(), scope = createRetrievalScope(snapshot), request = prepare('primary', snapshot, scope), controller = new AbortController();
  let calls = 0, gates = 0; const audit = [];
  await assert.rejects(retrievalLoop(async () => { calls++; return { requests: [{ kind: 'read', id: 's1', start: 1, count: 2 }] }; }, { ...request, signal: controller.signal }, scope, { correctProtocol: true, maxInputBytes: bytes(retrievalRequest(request, scope, [], {max:Number.MAX_SAFE_INTEGER,remaining:Number.MAX_SAFE_INTEGER})) + 50, beforeCall: () => { if (++gates === 2) controller.abort(); }, onRetrieved: rows => audit.push(...rows) }), /abort/i);
  assert.equal(calls, 1); assert.equal(gates, 2); assert.equal(scope.usage().calls, 1); assert.equal(audit.length, 0);
});

test('full review stage succeeds after initial full sources and one admitted read', async () => {
  const snapshot = fixture(); snapshot.files = snapshot.files.slice(0, 1); snapshot.context = [];
  const scope = createRetrievalScope(snapshot);
  // Let the stage use its real instructions; capture its first request to derive
  // a close cap in a separate, side-effect-free preparation run.
  let initial;
  await reviewSnapshot(snapshot, async req => { initial = req; return { findings: [], limitations: [] }; }, { enableRetrieval: true, correctProtocol: true, enableRiskPlanning: false });
  let calls = 0;
  const report = await reviewSnapshot(snapshot, async req => {
    const p = JSON.parse(req.input);
    if (++calls === 1) { assert.equal(p.file.left.text, snapshot.files[0].left.text); return { requests: [{ kind: 'read', id: 's1', start: 1, count: 2 }] }; }
    assert.equal(p.file.left.text, undefined);
    assert.equal(p.retrieved[0].result.text, snapshot.files[0].left.text);
    assert.equal(p.retrieved[0].result.omitted, undefined);
    return { findings: [], limitations: [] };
  }, { enableRetrieval: true, correctProtocol: true, enableRiskPlanning: false, maxInputBytes: bytes(initial) + 100 });
  assert.equal(report.status, 'completed'); assert.equal(calls, 2);
  assert.equal(report.modelCalls, 2); assert.equal(report.retrievalUsage.calls, 1);
  assert.equal(report.files[0].retrievalAudit.length, 1);
  assert.equal(scope.usage().calls, 0);
});

test('window synthesis followup strips only source bodies, not claims, changes or retrieved receipts', async () => {
  const raw = createRetrievalScope({ id: 's', files: [], context: [{ path: 'helper', text: 'evidence '.repeat(500) }] });
  const receipts = createEvidenceReceipts(raw.read), scope = { ...raw, read: receipts.read };
  const body = 'window '.repeat(1000);
  const payload = { snapshotId: 's', sourceMode: 'window-synthesis', file: { id: 'f' }, windows: [{ id: 'w', editIds: ['e1'], old: { text: body, start: 5, count: 1, hash: 'old-hash' }, new: { text: body, start: 8, count: 1, hash: 'new-hash' } }], windowIndex: [{ id: 'w', old: { start: 5, count: 1 }, new: { start: 8, count: 1 } }], changes: { status: 'changed', precision: 'exact', edits: [{ id: 'e1', old: { start: 5, count: 1 }, new: { start: 8, count: 1 } }], hunks: [{ id: 'h1', editIds: ['e1'] }] }, callerBindings: [{ text: 'must not drop caller claim' }], cppCallSites: [{ text: 'call hint' }], contextRelations: [{ text: 'relation hint' }], contextRelationNotice: 'not causal proof', defectGuidance: 'preserve guidance', contextMode: 'approved-retrieval', windowNotice: 'preserve original notice', risks: [{ text: 'hypothesis' }] };
  const request = { instructions: 'review', input: JSON.stringify(payload) };
  let calls = 0, limited = 0;
  await retrievalLoop(async req => {
    const p = JSON.parse(req.input);
    if (++calls === 1) { assert.deepEqual(p.windows, payload.windows); return { requests: [{ kind: 'read', id: 's1', start: 1, count: 1 }] }; }
    assert.deepEqual(Object.fromEntries(Object.entries(p).filter(([k]) => Object.hasOwn(payload, k))), withoutBodies(payload));
    assert.equal(p.retrievalFinalization,undefined);
    assert.deepEqual(p.retrievalRounds,{max:1,remaining:0});
    assert.equal(p.retrieved[0].result.text, 'evidence '.repeat(500));
    assert.equal(receipts.resolve({ receiptId: p.retrieved[0].result.receiptId }).text, p.retrieved[0].result.text);
    assert.match(req.instructions, /do not request more reads/);
    return { findings: [], limitations: ['Only supplied fragment checked'] };
  }, request, scope, { correctProtocol: true, maxInputBytes: bytes(retrievalRequest(request, scope, [], {max:Number.MAX_SAFE_INTEGER,remaining:Number.MAX_SAFE_INTEGER})) + 100, maxRounds: 1, onBudgetLimited: () => limited++ });
  assert.equal(calls, 2); assert.equal(limited, 0); assert.equal(scope.usage().calls, 1);
});
