import test from 'node:test';
import assert from 'node:assert/strict';
import { primarySeeds } from '../src/primary-seeds.mjs';
import { createRetrievalScope } from '../src/retrieval-scope.mjs';
import { preparePrimaryInput } from '../src/primary-input.mjs';
import { retrievalRequest } from '../src/retrieval-loop.mjs';
import { approvedCallerBindings } from '../src/caller-binding-input.mjs';
import { createReviewReaderAllocation } from '../src/review-reader-allocation.mjs';

const main = { id: 'f1', path: 'main.js', eligibility: 'reviewable', left: { text: 'old' }, right: { text: 'new' } };
const current = (count = 100) => Array.from({ length: count }, (_, i) => 'source line ' + (i + 1) + '\r\n').join('');
function fixture(options, contexts = [{ path: 'dep.js', text: current() }]) {
  const snapshot = { id: 'snap', files: [main], context: contexts };
  return { snapshot, scope: createRetrievalScope(snapshot, options) };
}
const relation = (line = 20) => ({ fromPath: 'main.js', toPath: 'dep.js', side: 'new', definitionHints: [{ declarationLine: line }] });
const request = extra => ({ instructions: 'Primary review', input: JSON.stringify({ file: { id: 'f1', path: 'main.js' }, context: [], sourceMode: 'change-windows', contextRelations: [relation()], ...extra }) });

test('known missing context declaration uses approved identity and exact original CRLF coordinates', () => {
  const { scope } = fixture(); const audit = [];
  const seeds = primarySeeds(scope, request(), { onRetrieved: items => audit.push(...items) });
  assert.equal(seeds.length, 1);
  assert.deepEqual(seeds[0].request, { kind: 'read', id: 's3', start: 16, count: 40 });
  assert.equal(seeds[0].result.start, 16);
  assert.equal(seeds[0].result.count, 40);
  assert.equal(seeds[0].result.text, current().split('\r\n').slice(15, 55).join('\r\n') + '\r\n');
  assert.equal(seeds[0].result.receiptId, undefined);
  assert.equal(scope.usage().calls, 1);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].sourceId, 's3');
  assert.equal(audit[0].resultBytes, Buffer.byteLength(JSON.stringify(seeds[0].result)));
  assert.ok(!JSON.stringify(audit).includes('source line'));
});

test('full-body context, main/related bodies and no-coordinate metadata are no-ops', () => {
  for (const extra of [
    { context: [{ path: 'dep.js', text: current() }] },
    { relatedFiles: [{ path: 'dep.js', right: { text: current() } }] },
    { contextRelations: [{ ...relation(), toPath: 'main.js' }] },
    { contextRelations: [{ ...relation(), definitionHints: [], line: 20 }] },
    { contextRelations: [{ ...relation(), definitionHints: [{ declarationLine: '20' }] }] },
    { contextRelations: [{ ...relation(), definitionHints: [{ declarationLine: 10000 }] }] },
    { contextRelations: [{ ...relation(), contextSide: 'old' }] },
    { contextRelations: [{ ...relation(), contextVersion: null, contextSide: 'old' }] },
    { contextRelations: [], contextCatalog: [{ id: 's3', path: 'dep.js' }] },
    { contextRelations: [], cppCallSites: [{ side: 'new', line: 20 }] },
    { sourceMode: 'window-synthesis' },
  ]) {
    const { scope } = fixture();
    assert.deepEqual(primarySeeds(scope, request(extra)), []);
    assert.equal(scope.usage().calls, 0);
  }
});

test('real primary-input full context body is not read again', () => {
  const { snapshot, scope } = fixture();
  snapshot.files = [{ ...main, left: { text: '' }, right: { text: 'import { Foo } from "./dep.js";\nFoo();\n' } }];
  snapshot.context = [{ path: 'dep.js', text: 'export function Foo() {}\n' }];
  const actual = createRetrievalScope(snapshot);
  const prepared = preparePrimaryInput(snapshot, snapshot.files[0], { instructions: 'review', scope: actual, maxInputBytes: 96000 });
  const payload = JSON.parse(prepared.payload);
  assert.equal(payload.contextRelations[0].definitionHints[0].declarationLine, 1);
  assert.deepEqual(primarySeeds(actual, { instructions: 'review', input: prepared.payload }), []);
  assert.equal(actual.usage().calls, 0);
  assert.equal(scope.usage().calls, 0);
});

test('actual relation shape seeds only missing destination definition, not main import/call coordinates', () => {
  const { snapshot } = fixture();
  snapshot.files = [{ ...main, left: { text: '' }, right: { text: 'import { Foo } from "./dep.js";\nFoo();\n' } }];
  snapshot.context = [{ path: 'dep.js', text: '\n'.repeat(49) + 'export function Foo() {}\n' }];
  const scope = createRetrievalScope(snapshot);
  const prepared = preparePrimaryInput(snapshot, snapshot.files[0], { instructions: 'review', scope, maxInputBytes: 96000 });
  const payload = JSON.parse(prepared.payload); payload.context = [];
  const seeds = primarySeeds(scope, { instructions: 'review', input: JSON.stringify(payload) });
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].result.sourceId, 's3');
  assert.equal(seeds[0].result.start, 46);
  assert.equal(seeds[0].result.count, 5);
  assert.equal(seeds[0].result.text, '\n'.repeat(4) + 'export function Foo() {}\n');
});

test('real window payload lacking context gets exact imported definition without seeding main windows', () => {
  const lines = ['import { Foo } from "./dep.js";', 'Foo();', ...Array.from({ length: 100 }, () => 'filler'.repeat(30))];
  const old = lines.join('\n'), changed = [...lines]; changed[60] = 'new value';
  const file = { ...main, left: { text: old }, right: { text: changed.join('\n') } };
  const snapshot = { id: 'windows', files: [file], context: [{ path: 'dep.js', text: '\n'.repeat(49) + 'export function Foo() {}\n' + 'filler\n'.repeat(1000) }] };
  const scope = createRetrievalScope(snapshot);
  const prepared = preparePrimaryInput(snapshot, file, { instructions: 'review', scope, maxInputBytes: 14000 });
  const payload = JSON.parse(prepared.payload);
  assert.equal(payload.sourceMode, 'change-windows');
  assert.deepEqual(payload.context, []);
  assert.ok(payload.windows.length);
  const seeds = primarySeeds(scope, { instructions: 'review', input: prepared.payload }, { maxInputBytes: 14000 });
  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].request.id, scope.catalog().find(source => source.side === 'context').id);
  assert.equal(seeds[0].result.start, 46);
});

test('actual approvedCallerBindings historical fields map old-only caller coordinates', () => {
  const context = { path: 'dep.js', oldText: current(), oldRevision: 'base' };
  const input = { context: [context], history: { base: 'base', target: 'target' }, callerDiscovery: { candidates: [{ targetPath: 'main.js', fromPath: 'dep.js', side: 'old', revision: 'base', bindings: [{ importLine: 20, callLine: 80, declarationLine: 1 }] }] } };
  const bindings = approvedCallerBindings(input, main);
  assert.equal(bindings[0].contextSide, 'context-old');
  assert.equal(bindings[0].targetRevision, 'base');
  // A minimal approved reader with an old-only context is enough; the helper
  // cannot invent a current body or substitute it for this old-side source.
  const scope = fixture().scope;
  const catalog = scope.catalog().map(source => source.path === 'dep.js' ? { ...source, side: 'context-old' } : source);
  const seeds = primarySeeds({ ...scope, catalog: () => catalog }, request({ contextRelations: [], callerBindings: bindings }));
  assert.deepEqual(seeds.map(item => item.request.start), [16, 76]);
  assert.ok(seeds.every(item => item.request.id === 's3'));
});

test('historical relation/caller side is exact; missing old source never substitutes target', () => {
  const contexts = [{ path: 'dep.js', text: current(), revision: 'new', oldText: current().replaceAll('source', 'old'), oldRevision: 'old' }];
  const snapshot = { id: 'history', files: [main], context: contexts, history: { base: 'old', target: 'new' } };
  const scope = createRetrievalScope(snapshot);
  const seeds = primarySeeds(scope, request({ contextRelations: [
    { ...relation(10), side: 'old', contextSide: 'old', contextVersion: 'old' },
    { ...relation(60), side: 'new', contextSide: 'new', contextVersion: 'new' },
  ] }));
  assert.deepEqual(seeds.map(item => item.result.sourceId), ['s4', 's3']);
  assert.match(seeds[0].result.text, /old line/);
  assert.match(seeds[1].result.text, /source line/);
  const missing = createRetrievalScope({ ...snapshot, context: [{ path: 'dep.js', text: current(), revision: 'new' }] });
  assert.deepEqual(primarySeeds(missing, request({ contextRelations: [{ ...relation(), side: 'old', contextSide: 'old', contextVersion: 'old' }] })), []);
  assert.equal(missing.usage().calls, 0);
  const mismatch = createRetrievalScope(snapshot);
  assert.deepEqual(primarySeeds(mismatch, request({ contextRelations: [{ ...relation(), side: 'old', contextSide: 'new', contextVersion: 'old' }] })), []);
});

test('caller bindings read caller import/call locations, never target declarationLine or opposite side', () => {
  const { scope } = fixture();
  const seeds = primarySeeds(scope, request({ contextRelations: [], callerBindings: [{ fromPath: 'dep.js', bindings: [{ importLine: 10, callLine: 70, declarationLine: 1 }] }] }));
  assert.deepEqual(seeds.map(item => item.request.start), [6, 66]);
  assert.ok(seeds.every(item => item.request.id === 's3'));
  const historic = fixture().scope;
  assert.deepEqual(primarySeeds(historic, request({ contextRelations: [], callerBindings: [{ fromPath: 'dep.js', side: 'old', revision: 'r1', targetRevision: 'r1', contextSide: 'context-old', bindings: [{ callLine: 20 }] }] })), []);
  const malformed = fixture().scope;
  assert.deepEqual(primarySeeds(malformed, request({ contextRelations: [], callerBindings: [{ fromPath: 'dep.js', side: 'old', revision: 'r1', targetRevision: 'r2', contextSide: 'context', bindings: [{ callLine: 20 }] }] })), []);
});

test('reverse context relations use source import/calls not main definition coordinates', () => {
  const { scope } = fixture();
  const seeds = primarySeeds(scope, request({ contextRelations: [{ fromPath: 'dep.js', toPath: 'main.js', side: 'context', line: 8, callSites: [{ line: 90 }], definitionHints: [{ declarationLine: 1 }] }] }));
  assert.deepEqual(seeds.map(item => item.request.start), [4, 86]);
});

test('at most four approved reads of forty lines, deduping provided ranges and preserving reserves', () => {
  const { scope } = fixture();
  const seeds = primarySeeds(scope, request({ contextRelations: [relation(10), relation(20), relation(55), relation(99)] }));
  assert.equal(seeds.length, 3);
  assert.ok(seeds.every(item => item.request.count <= 40));
  assert.equal(scope.usage().calls, 3);
  const bounded = fixture(undefined, Array.from({ length: 6 }, (_, i) => ({ path: 'd' + i + '.js', text: current() }))).scope;
  const four = primarySeeds(bounded, request({ contextRelations: Array.from({ length: 6 }, (_, i) => ({ ...relation(), toPath: 'd' + i + '.js' })) }));
  assert.equal(four.length, 4);
  assert.equal(bounded.usage().calls, 4);
  const reserved = fixture({ maxCalls: 5 }).scope;
  assert.equal(primarySeeds(reserved, request({ contextRelations: [relation(10), relation(90)] })).length, 1);
  assert.equal(reserved.budget().remainingCalls, 4);
  const low = fixture({ maxCalls: 4 }).scope;
  assert.deepEqual(primarySeeds(low, request()), []);
  assert.equal(low.usage().calls, 0);
});

test('input/output overflow rolls back before audit and ordinary smaller retrieval remains possible', () => {
  const { scope } = fixture(); const audit = [];
  const req = request(); const next = retrievalRequest(req, scope);
  const maxInputBytes = Buffer.byteLength(next.input) + Buffer.byteLength(next.instructions) + 50;
  assert.deepEqual(primarySeeds(scope, req, { maxInputBytes, onRetrieved: items => audit.push(...items) }), []);
  assert.deepEqual(scope.usage(), { calls: 0, outputBytes: 0 });
  assert.deepEqual(audit, []);
  assert.equal(scope.read({ id: 's3', start: 20, count: 1 }).count, 1);
  const output = fixture({ maxOutputBytes: 16500 }).scope;
  assert.deepEqual(primarySeeds(output, request()), []);
  assert.equal(output.usage().calls, 0);
  const legacy = fixture().scope;
  assert.deepEqual(primarySeeds({ ...legacy, transaction: undefined }, request()), []);
  assert.equal(legacy.usage().calls, 0);
});

test('strict options and cancellation do not consume reader or publish uncommitted data', () => {
  for (const maxInputBytes of [0, -1, 1.5, '96000', NaN, Infinity]) assert.throws(() => primarySeeds(fixture().scope, request(), { maxInputBytes }), /Invalid primary seed options/);
  for (const signal of [{ throwIfAborted() {} }, null]) assert.throws(() => primarySeeds(fixture().scope, request(), { signal }), /Invalid primary seed options/);
  const controller = new AbortController(); controller.abort(Error('cancelled'));
  const { scope } = fixture();
  assert.throws(() => primarySeeds(scope, request(), { signal: controller.signal }), /cancelled/);
  assert.equal(scope.usage().calls, 0);
  const audit = [], cancelling = fixture().scope;
  const req = request(); req.signal = new AbortController().signal;
  const during = new AbortController();
  assert.throws(() => primarySeeds({ ...cancelling, read(operation) { const result = cancelling.read(operation); during.abort(Error('cancel mid read')); return result; } }, req, { signal: during.signal, onRetrieved: items => audit.push(...items) }), /cancel mid read/);
  assert.deepEqual(cancelling.usage(), { calls: 0, outputBytes: 0 });
  assert.deepEqual(audit, []);
});

test('failed optional reads are bounded too and never audited', () => {
  const { scope } = fixture(undefined, Array.from({ length: 10 }, (_, i) => ({ path: 'dep' + i + '.js', text: current() })));
  let reads = 0; const audit = [];
  const limited = { ...scope, read(operation) { reads++; return scope.read(operation); } };
  assert.deepEqual(primarySeeds(limited, request({ contextRelations: Array.from({ length: 10 }, (_, i) => ({ ...relation(), toPath: 'dep' + i + '.js' })) }), { maxInputBytes: 1, onRetrieved: items => audit.push(...items) }), []);
  assert.equal(reads, 4);
  assert.deepEqual(scope.usage(), { calls: 0, outputBytes: 0 });
  assert.deepEqual(audit, []);
});

test('provided historical body suppresses only its own version and synthesis phases never read', () => {
  const { scope } = fixture();
  const seeds = primarySeeds(scope, request({ context: [{ path: 'dep.js', oldText: 'old body' }] }));
  assert.equal(seeds.length, 1);
  const synth = fixture().scope;
  assert.deepEqual(primarySeeds(synth, { ...request(), reviewPhase: 'interaction-synthesis' }), []);
  assert.equal(synth.usage().calls, 0);
});

test('exact cached context seed remains usable with zero root calls and no evidence receipt reuse', () => {
  const { scope } = fixture({ reuseResults: true, maxCalls: 1 });
  const operation = { kind: 'read', id: 's3', start: 16, count: 40 };
  scope.read(operation); const before = scope.usage(), audit = [];
  assert.equal(scope.budget().remainingCalls, 0);
  const seeds = primarySeeds(scope, request(), { onRetrieved: records => audit.push(...records) });
  assert.equal(seeds.length, 1); assert.equal(seeds[0].result.receiptId, undefined);
  assert.deepEqual(seeds[0].request, operation);
  assert.equal(scope.usage().calls, before.calls); assert.equal(scope.usage().cacheHits, before.cacheHits + 1);
  assert.ok(scope.usage().outputBytes > before.outputBytes); assert.equal(audit.length, 1);
});

test('allocated exact cache seed is not blocked by a two-call quota while misses retain original reserve', () => {
  const { scope: root } = fixture({ reuseResults: true, maxCalls: 5 });
  root.read({ id: 's3', start: 16, count: 40 });
  const allocation = createReviewReaderAllocation(root, [{ id: 'first', weight: 1 }, { id: 'later', weight: 1 }]);
  const scope = allocation.scope('first'), before = root.usage();
  assert.equal(scope.budget().remainingCalls, 2);
  assert.equal(primarySeeds(scope, request()).length, 1);
  assert.equal(root.usage().calls, before.calls);
  const miss = request({ contextRelations: [relation(80)] }), after = root.usage();
  assert.deepEqual(primarySeeds(scope, miss), []); assert.deepEqual(root.usage(), after);
});

test('cache metadata never authorizes different range or source-side misses at zero calls', () => {
  for (const warm of [{ kind: 'read', id: 's3', start: 16, count: 39 }, { kind: 'read', id: 's3', start: 17, count: 40 }, { kind: 'read', id: 's2', start: 1, count: 1 }]) {
    const { scope } = fixture({ reuseResults: true, maxCalls: 1 }); scope.read(warm); const before = scope.usage();
    assert.deepEqual(primarySeeds(scope, request()), []); assert.deepEqual(scope.usage(), before);
  }
});

test('cached seed overflow and mid-delivery cancellation atomically preserve cache bytes and audits', () => {
  for (const mode of ['fit', 'bytes', 'cancel']) {
    const { scope } = fixture({ reuseResults: true, maxCalls: 1, ...(mode === 'bytes' ? { maxOutputBytes: 17000 } : {}) });
    scope.read({ id: 's3', start: 16, count: 40 }); const before = scope.usage(), audit = [], controller = new AbortController();
    const wrapped = mode === 'cancel' ? { ...scope, read(operation, decorate) { const result = scope.read(operation, decorate); controller.abort(Error('cancel cached primary')); return result; } } : scope;
    const execute = () => primarySeeds(wrapped, request(), { maxInputBytes: mode === 'fit' ? 1 : 98304, signal: controller.signal, onRetrieved: records => audit.push(...records) });
    if (mode === 'cancel') assert.throws(execute, /cancel cached primary/); else assert.deepEqual(execute(), []);
    assert.deepEqual(scope.usage(), before); assert.equal(audit.length, 0);
  }
});

test('authorization errors propagate and model supplied retrieved bodies are never reused as evidence', () => {
  const { scope } = fixture();
  assert.throws(() => primarySeeds({ ...scope, read() { throw Error('unauthorized source'); } }, request()), /unauthorized source/);
  const fresh = fixture().scope;
  const seeds = primarySeeds(fresh, request({ retrieved: [{ request: { kind: 'read', id: 'foreign' }, result: { text: 'MODEL PROSE' } }] }));
  assert.equal(seeds.length, 1);
  assert.ok(!seeds[0].result.text.includes('MODEL PROSE'));
});
