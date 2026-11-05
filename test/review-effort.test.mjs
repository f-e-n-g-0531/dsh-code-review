import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewEffortPolicy, reviewEffortMode, counterVerificationEligible } from '../src/review-effort.mjs';

function fixture(before = 'const n = 1;\n', after = 'const n = 2;\n', path = 'main.js') {
  return { id: 'snapshot-1', root: 'G:/repo', vcs: 'git', files: [{ id: 'f1', path, eligibility: 'reviewable',
    left: { text: before, exists: true }, right: { text: after, exists: true } }] };
}

test('auto defaults to standard, explicit tiers retain baseline strict verification', () => {
  const input = fixture(), policy = reviewEffortPolicy(input);
  assert.equal(reviewEffortMode(), 'auto');
  assert.equal(policy.tier, 'standard'); assert.equal(policy.status, 'planned');
  assert.equal(policy.identity.complete, true); assert.match(policy.identity.sourceFingerprint, /^[a-f0-9]{64}$/);
  for (const mode of ['quick', 'standard', 'deep']) {
    const result = reviewEffortPolicy(input, { mode });
    assert.equal(result.tier, mode); assert.deepEqual(result.checks, policy.checks);
    assert.equal(result.humanReview.approvalGranted, false);
  }
});

test('invalid mode rejects, malformed snapshots do not become low-risk', () => {
  for (const mode of [null, '', 'AUTO', 'fast', 1, false, {}]) {
    assert.throws(() => reviewEffortMode(mode)); assert.throws(() => reviewEffortPolicy(fixture(), { mode }));
  }
  for (const input of [null, {}, { files: {} }]) assert.throws(() => reviewEffortPolicy(input));
  const unknown = reviewEffortPolicy({ files: [null] });
  assert.equal(unknown.tier, 'deep'); assert.equal(unknown.scan.complete, false);
  assert.equal(unknown.identity.sourceFingerprint, null);
});

test('path-only hints are weak advisory, changed content drives escalation', () => {
  for (const path of ['src/auth.js', '.github/workflows/ci.yml', String.raw`.github\workflows\ci.yml`, '.gitlab-ci.yml']) {
    const policy = reviewEffortPolicy(fixture(undefined, undefined, path));
    assert.equal(policy.tier, 'standard'); assert.deepEqual(policy.counterVerification.categories, []);
    assert.equal(policy.humanReview.required, true); assert.equal(policy.humanReview.advisoryOnly, true);
    assert.ok(policy.reasons.includes('sensitive-path-hint'));
  }
  const unchangedContext = reviewEffortPolicy(fixture('await previous();\nlet n = 1;\n', 'await previous();\nlet n = 2;\n'));
  assert.equal(unchangedContext.tier, 'standard');
  for (const [code, category] of [['dispose();', 'lifecycle'], ['await work();', 'concurrency'], ['transaction.commit();', 'persistence'], ['export function f() {}', 'compatibility'], ['authorize(user);', 'sensitive']]) {
    const policy = reviewEffortPolicy(fixture('old();\n', code + '\n'));
    assert.equal(policy.tier, 'deep'); assert.ok(policy.reasons.includes('changed-' + category));
    assert.ok(policy.counterVerification.guidance.length > 0);
    assert.equal(policy.status, 'planned'); assert.equal(policy.humanReview.approvalGranted, false);
  }
  assert.equal(reviewEffortPolicy(fixture('dispose();\n', 'done();\n')).tier, 'deep');
});

test('quick never clears checks or sensitive-human advisory', () => {
  const policy = reviewEffortPolicy(fixture('old();', 'authorize(user);'), { mode: 'quick' });
  assert.equal(policy.tier, 'quick'); assert.equal(policy.humanReview.required, true);
  assert.match(policy.checks.join(' '), /strict evidence verification/);
  assert.equal(policy.counterVerification.eligible, false);
});

test('counterverification is eligibility only, deep high/critical and fresh evidence', () => {
  const deep = reviewEffortPolicy(fixture(), { mode: 'deep' });
  for (const severity of ['high', 'critical']) assert.equal(counterVerificationEligible(deep, { severity }), true);
  for (const severity of [undefined, null, 'unknown', 'HIGH', 'low', 'medium', 'P1', 1]) assert.equal(counterVerificationEligible(deep, { severity }), false);
  assert.equal(counterVerificationEligible(reviewEffortPolicy(fixture()), { severity: 'high' }), false);
  assert.equal(counterVerificationEligible(null, { severity: 'high' }), false);
  assert.equal(deep.counterVerification.requiresFreshEvidence, true);
  assert.match(deep.counterVerification.instructions, /separate fresh verifier/);
  assert.match(deep.counterVerification.instructions, /do not downgrade or clear evidence/);
});

test('identity changes with exact sources, repository, path, side and metadata', () => {
  const input = fixture(), fingerprint = reviewEffortPolicy(input).identity.sourceFingerprint;
  for (const mutate of [x => x.root = 'G:/other', x => x.id = 'other', x => x.files[0].path = 'other.js',
    x => x.files[0].left.text += ' ', x => x.files[0].right.text += ' ', x => x.files[0].right.exists = false,
    x => x.files[0].right.hash = 'different', x => x.changeScope = 'staged']) {
    const next = structuredClone(input); mutate(next);
    assert.notEqual(reviewEffortPolicy(next).identity.sourceFingerprint, fingerprint);
  }
  assert.equal(reviewEffortPolicy(input).identity.reusableCoverage, false);
});

test('no mutation, raw source/identity secrets or interpretation of requirements', () => {
  const secret = 'SECRET_VALUE_0123456789';
  const input = fixture('const key = "' + secret + '";', 'const key = "' + secret + '2";', secret + '.js');
  input.root = secret; input.id = secret;
  Object.defineProperty(input, 'businessRequirement', { get() { throw new Error('must not interpret requirements'); } });
  const before = structuredClone({ ...fixture(), files: input.files });
  const first = reviewEffortPolicy(input), second = reviewEffortPolicy(input);
  assert.deepEqual(first, second); assert.equal(JSON.stringify(first).includes(secret), false);
  assert.deepEqual(input.files, before.files);
  first.checks.push('tamper'); first.counterVerification.categories.push('tamper'); first.scan.limits.files = 1;
  assert.deepEqual(reviewEffortPolicy(input), second);
});

test('file/source/global memory limits cannot certify truncated source identities', () => {
  const tooMany = fixture(); tooMany.files = Array.from({ length: 201 }, () => tooMany.files[0]);
  Object.defineProperty(tooMany.files, 200, { get() { throw new Error('must not scan beyond cap'); } });
  const capped = reviewEffortPolicy(tooMany);
  assert.equal(capped.scan.filesScanned, 200); assert.equal(capped.scan.complete, false);
  assert.equal(capped.identity.sourceFingerprint, null); assert.ok(capped.reasons.includes('file-limit'));
  for (const input of [fixture('', 'x'.repeat(262145)), { ...fixture(), root: 'x'.repeat(4097) },
    { ...fixture(), files: [{ path: 'x.js', left: {}, right: {} }] }]) {
    const policy = reviewEffortPolicy(input); assert.equal(policy.tier, 'deep');
    assert.equal(policy.identity.complete, false); assert.equal(policy.identity.sourceFingerprint, null);
  }
  const global = fixture('x'.repeat(200000), 'y'.repeat(200000)); global.files = Array(6).fill(global.files[0]);
  const result = reviewEffortPolicy(global); assert.equal(result.scan.complete, false); assert.ok(result.reasons.includes('source-limit'));
});

test('bounded exact diff exhaustion is uncertainty, never an inferred changed category', () => {
  const input = fixture(Array.from({ length: 300 }, (_, i) => 'before' + i).join('\n'), Array.from({ length: 300 }, (_, i) => 'after' + i).join('\n'));
  const policy = reviewEffortPolicy(input);
  assert.equal(policy.tier, 'deep'); assert.equal(policy.scan.complete, false);
  assert.ok(policy.reasons.includes('change-scope-unavailable')); assert.deepEqual(policy.counterVerification.categories, []);
  assert.equal(policy.identity.complete, true); // Complete sources can be bound even when their edit script is unavailable.
});
