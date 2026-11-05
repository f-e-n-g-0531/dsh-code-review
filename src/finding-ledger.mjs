import { createHash } from 'node:crypto';

// Navigation and human disposition metadata only. Never a source/evidence receipt,
// verification result, coverage certificate, approval, or permission to run again.
const MAX_CYCLES = 3;
const LIMIT = 10000;
const TRUST = 'historical-metadata-not-evidence';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = message => { throw new Error('Finding ledger: ' + message); };
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 16000;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const record = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function exact(value, keys) {
  if (!record(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) fail('unknown or invalid fields');
}
function list(value) { if (!Array.isArray(value) || value.length > LIMIT) fail('invalid or excessive list'); }
function path(value) {
  // SVN uses the canonical repository root for directory property changes.
  if (value === '.') return value;
  if (!text(value) || value.includes('\\') || value.includes('\0') || value.startsWith('/') || /^[a-z]:/i.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) fail('invalid repository-relative path');
  return value;
}
function identityValue(value) {
  const keys = ['repository', 'route', 'rulesHash', 'requirementPolicyHash'];
  exact(value, keys);
  if (!text(value.repository) || !text(value.route) || !hash(value.rulesHash) || !hash(value.requirementPolicyHash)) fail('invalid identity');
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}
function sameIdentity(left, right) { if (JSON.stringify(left) !== JSON.stringify(right)) fail('identity mismatch'); }
function freeze(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
function decisionValue(value) {
  exact(value, ['decision', 'reason', 'cycle']);
  if (!['fixed', 'refuted', 'intentional', 'deferred'].includes(value.decision) || !text(value.reason) || !Number.isInteger(value.cycle) || value.cycle < 1 || value.cycle > MAX_CYCLES) fail('invalid human decision');
  return { decision: value.decision, reason: value.reason, cycle: value.cycle };
}
function validatePrevious(value, identity) {
  exact(value, ['schemaVersion', 'identity', 'originSnapshotId', 'chainOrigin', 'cycle', 'maxCycles', 'nextAction', 'trust', 'snapshotId', 'findings']);
  sameIdentity(identityValue(value.identity), identity);
  if (value.schemaVersion !== 1 || value.trust !== TRUST || value.maxCycles !== MAX_CYCLES || !Number.isInteger(value.cycle) || value.cycle < 1 || value.cycle > MAX_CYCLES || !text(value.snapshotId) || !text(value.originSnapshotId) || value.chainOrigin !== digest([identity, value.originSnapshotId]) || value.nextAction !== (value.cycle === MAX_CYCLES ? 'step-back' : 'human-review')) fail('invalid chain');
  list(value.findings);
  const ids = new Set();
  const findings = value.findings.map(item => {
    exact(item, ['id', 'path', 'side', 'anchorHash', 'claimHash', 'matchable', 'firstSeen', 'lastSeen', 'observation', 'findingIndices', 'humanDecisions']);
    path(item.path);
    if (item.path === '.' && !['property', 'file'].includes(item.side)) fail('root findings require property or file anchor');
    if (!hash(item.id) || ids.has(item.id) || !hash(item.anchorHash) || !hash(item.claimHash) || !['old', 'new', 'property', 'file'].includes(item.side) || typeof item.matchable !== 'boolean' || item.matchable !== (item.side !== 'file') || !['new', 'repeated', 'not-observed'].includes(item.observation) || !Number.isInteger(item.firstSeen) || !Number.isInteger(item.lastSeen) || item.firstSeen < 1 || item.lastSeen < item.firstSeen || item.lastSeen > value.cycle) fail('invalid historical finding');
    list(item.findingIndices); list(item.humanDecisions);
    if (item.findingIndices.some(index => !Number.isSafeInteger(index) || index < 0) || new Set(item.findingIndices).size !== item.findingIndices.length) fail('invalid finding indices');
    const humanDecisions = item.humanDecisions.map(decisionValue);
    if (humanDecisions.length > MAX_CYCLES || humanDecisions.some(d => d.cycle > value.cycle) || new Set(humanDecisions.map(d => d.cycle)).size !== humanDecisions.length) fail('invalid decision history');
    const expected = digest([identity.repository, item.path, item.side, item.anchorHash, item.claimHash, item.matchable ? null : value.chainOrigin, item.matchable ? null : item.firstSeen]);
    if (item.id !== expected) fail('invalid finding fingerprint');
    ids.add(item.id);
    return { ...item, findingIndices: [], humanDecisions };
  });
  return { ...value, findings };
}

/** Accepts the real report.findings shape from review.mjs (including project reports).
 * Does not mutate or copy report verification, evidence receipts, status or source.
 * Hashes exact source anchor and defect claim; prose drift deliberately makes a new
 * candidate rather than heuristically merging distinct causes by title/path.
 */
export function buildFindingLedger(report, identity, options = {}) {
  identity = identityValue(identity);
  exact(options, ['previous', 'outcomes']);
  if (!record(report) || !text(report.snapshotId)) fail('invalid current report');
  list(report.findings);
  const previous = options.previous === undefined ? undefined : validatePrevious(options.previous, identity);
  if (previous?.cycle === MAX_CYCLES) fail('cycle cap reached; step back with human review, not automatic approval');
  const cycle = (previous?.cycle ?? 0) + 1;
  const originSnapshotId = previous?.originSnapshotId ?? report.snapshotId;
  const chainOrigin = digest([identity, originSnapshotId]);
  const rows = new Map((previous?.findings ?? []).map(item => [item.id, { ...item, observation: 'not-observed' }]));
  report.findings.forEach((finding, index) => {
    if (!record(finding)) fail('invalid current finding');
    const mapped = finding.path === undefined && Array.isArray(report.files) ? report.files.filter(file => file.fileId === finding.fileId && (finding.batchSnapshotId === undefined || file.batchSnapshotId === finding.batchSnapshotId)) : [];
    const findingPath = path(finding.path ?? (mapped.length === 1 ? mapped[0].path : undefined)), anchor = finding.anchor;
    if (!record(anchor) || !['line', 'property', 'file'].includes(anchor.kind)) fail('invalid current anchor');
    if (findingPath === '.' && !['property', 'file'].includes(anchor.kind)) fail('root findings require property or file anchor');
    const side = anchor.kind === 'line' ? anchor.side : anchor.kind;
    if (anchor.kind === 'line' && (!['old', 'new'].includes(side) || !text(anchor.snippet))) fail('missing exact snippet/side');
    if (anchor.kind === 'property' && !text(anchor.name)) fail('missing exact property');
    for (const key of ['evidence', 'trigger', 'impact']) if (!text(finding[key])) fail('missing defect claim');
    const a = finding.attribution;
    const causal = ['beforeBehavior', 'afterBehavior', 'reason'].map(key => {
      if (a?.[key] !== undefined && !text(a[key])) fail('invalid causal claim');
      return a?.[key] ?? null;
    });
    // Qualified interaction refs differentiate cross-file claims without transferring receipts.
    const interaction = finding.interaction?.editRefs;
    if (interaction !== undefined) {
      list(interaction);
      for (const ref of interaction) if (!record(ref) || !text(ref.fileId) || !text(ref.editId)) fail('invalid interaction claim');
    }
    const claimHash = digest([finding.evidence, finding.trigger, finding.impact, causal, interaction?.map(ref => [ref.fileId, ref.editId]).sort() ?? null]);
    const anchorHash = digest(anchor.kind === 'line' ? anchor.snippet : anchor.kind === 'property' ? anchor.name : 'file');
    const matchable = anchor.kind !== 'file';
    const id = digest([identity.repository, findingPath, side, anchorHash, claimHash, matchable ? null : chainOrigin, matchable ? null : cycle]);
    const existing = rows.get(id);
    if (existing) { existing.observation = existing.firstSeen === cycle ? 'new' : 'repeated'; existing.lastSeen = cycle; existing.findingIndices.push(index); }
    else rows.set(id, { id, path: findingPath, side, anchorHash, claimHash, matchable, firstSeen: cycle, lastSeen: cycle, observation: 'new', findingIndices: [index], humanDecisions: [] });
  });
  const outcomes = options.outcomes ?? [];
  list(outcomes);
  const decided = new Set();
  for (const outcome of outcomes) {
    exact(outcome, ['id', 'decision', 'reason']);
    const item = rows.get(outcome.id);
    if (!item || decided.has(outcome.id)) fail('unknown or duplicate outcome id');
    decided.add(outcome.id);
    item.humanDecisions.push(decisionValue({ decision: outcome.decision, reason: outcome.reason, cycle }));
  }
  if (rows.size > LIMIT) fail('excessive historical findings');
  return freeze({ schemaVersion: 1, identity, originSnapshotId, chainOrigin, cycle, maxCycles: MAX_CYCLES, nextAction: cycle === MAX_CYCLES ? 'step-back' : 'human-review', trust: TRUST, snapshotId: report.snapshotId, findings: [...rows.values()] });
}

function snapshotMetadata(value) {
  exact(value, ['identity', 'snapshotId', 'files']);
  const identity = identityValue(value.identity);
  if (!text(value.snapshotId)) fail('invalid snapshot metadata');
  list(value.files);
  const files = new Map();
  for (const file of value.files) {
    exact(file, ['path', 'hash', 'dependencies']);
    const name = path(file.path);
    if (files.has(name) || file.hash !== undefined && !hash(file.hash)) fail('invalid or duplicate source hash');
    const dependencies = file.dependencies;
    if (dependencies !== undefined) {
      list(dependencies);
      const seen = new Set();
      for (const dep of dependencies) {
        exact(dep, ['path', 'hash']); path(dep.path);
        if (seen.has(dep.path) || dep.hash !== undefined && !hash(dep.hash)) fail('invalid dependency');
        seen.add(dep.path);
      }
    }
    files.set(name, file);
  }
  return { identity, files };
}

/** Explicit complete dependency lists are caller-supplied metadata, not discovery
 * or proof. Unknown/changing deps conservatively invalidate their transitive users.
 * Even unchanged paths are navigation only, never full coverage or reused evidence.
 */
export function planIncrementalReview(previous, current) {
  const old = snapshotMetadata(previous), next = snapshotMetadata(current);
  sameIdentity(old.identity, next.identity);
  const safe = new Set();
  for (const [name, file] of next.files) {
    const before = old.files.get(name);
    if (!before || !hash(file.hash) || file.hash !== before.hash || !Array.isArray(file.dependencies) || !Array.isArray(before.dependencies)) continue;
    const deps = list => list.map(dep => [dep.path, dep.hash]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    if (JSON.stringify(deps(file.dependencies)) !== JSON.stringify(deps(before.dependencies))) continue;
    if (file.dependencies.every(dep => hash(dep.hash) && next.files.get(dep.path)?.hash === dep.hash && old.files.get(dep.path)?.hash === dep.hash)) safe.add(name);
  }
  // Fixed point is cycle-safe: an unchanged, fully-known dependency cycle is safe
  // navigation; any unknown/changed member invalidates every reachable dependent.
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of safe) if (next.files.get(name).dependencies.some(dep => !safe.has(dep.path))) { safe.delete(name); changed = true; }
  }
  return freeze({ freshReviewPaths: [...next.files.keys()].filter(name => !safe.has(name)), unchangedNavigationPaths: [...next.files.keys()].filter(name => safe.has(name)), removedPaths: [...old.files.keys()].filter(name => !next.files.has(name)), coverage: false, trust: TRUST, requiresFreshEvidence: true });
}
