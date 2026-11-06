import { createHash } from 'node:crypto';
import { lineDiff } from './line-diff.mjs';

// Planning only: these lexical signals are neither findings nor approval evidence.
const LIMITS = Object.freeze({ files: 200, sourceChars: 262144, totalSourceChars: 2097152, metadataChars: 4096 });
const BASELINE = Object.freeze([
  'Require exact changed-code evidence, a concrete trigger and impact before reporting a defect.',
  'Compare before/after behavior and captured callers; missing context remains uncertainty.',
  'Trace validation and rejection paths from the public entry point: a rejected request must not newly mutate shared state used by already accepted work unless the captured contract permits it. An old shared-state mechanism does not by itself refute a newly reachable mutation-before-validation path.',
  'For moved or newly added implementations, locate the captured previous public wrapper and delegated implementation before calling behavior preexisting. An empty old side of the new file is not proof that no previous public behavior exists.',
  'Retain strict evidence verification in every effort tier; no policy result proves completion or approval.',
]);
const CATEGORIES = Object.freeze({
  lifecycle: { pattern: /\b(?:dispose|destroy|shutdown|close|release|free|cancel|abort|unsubscribe|removeEventListener)\b/i,
    guidance: 'Seek cleanup guards, ownership transfers and completion before teardown on success, failure and cancellation paths.' },
  concurrency: { pattern: /\b(?:await|async|mutex|lock|atomic|thread|worker|synchronized|volatile|Promise|goroutine)\b/i,
    guidance: 'Seek actual synchronization, queue/actor isolation and cancellation ordering; source order alone is not a happens-before proof.' },
  persistence: { pattern: /\b(?:transaction|commit|rollback|writeFile|rename|fsync|INSERT|UPDATE|DELETE|migration|serialize|deserialize)\b/i,
    guidance: 'Seek rollback, atomic publication, schema/version guards and recovery behavior against captured storage consumers.' },
  compatibility: { pattern: /\b(?:export|public|interface|ABI|API|schema|protocol|deprecated|version|override)\b/i,
    guidance: 'Seek caller contracts, compatibility adapters and supported runtime/version evidence; do not invent a public contract.' },
  sensitive: { pattern: /\b(?:auth|authorize|authorization|authenticate|authentication|permissions?|privilege|chmod|sudo|install|update|release|CI|postinstall|preinstall|pull_request_target|workflow_dispatch|publish|deploy|installer|autoUpdate)\b/i,
    guidance: 'Seek trust-boundary validation and explicit authorization in captured code; installation, update, CI and release actions require separate human handling, never automatic approval.' },
});
const PATH_HINT = /(?:^|[\\/_.-])(?:auth|permissions?|install|update|release|deploy)(?:[\\/_.-]|$)|(?:^|[\\/])\.github[\\/]workflows[\\/]|(?:^|[\\/])\.gitlab-ci\.yml$/i;
const digest = value => createHash('sha256').update(value).digest('hex');

export function reviewEffortMode(value = 'auto') {
  if (!['auto', 'quick', 'standard', 'deep'].includes(value)) throw new TypeError('Invalid review effort mode');
  return value;
}

// Unknown severities are never silently promoted or treated as verified severe findings.
export function counterVerificationEligible(policy, candidate) {
  return policy?.version === 1 && policy.tier === 'deep' && policy.counterVerification?.eligible === true &&
    ['high', 'critical'].includes(candidate?.severity);
}

/** Pure bounded planning over captured snapshot.files[].left/right.text.
 * Identity is a source/selected-metadata binding, not a receipt or reusable coverage.
 * A null sourceFingerprint explicitly means the complete binding is unavailable.
 * Requirements and other free-text instructions are not interpreted or returned.
 */
export function reviewEffortPolicy(snapshot, { mode = 'auto' } = {}) {
  mode = reviewEffortMode(mode);
  if (!snapshot || !Array.isArray(snapshot.files)) throw new TypeError('Invalid effort snapshot');
  const reasons = new Set(), categories = new Set();
  let complete = true, used = 0, filesScanned = 0, exactChanges = true;
  const hash = createHash('sha256');
  const field = value => {
    if (value === undefined) return null;
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
    if (typeof value === 'string' && value.length <= LIMITS.metadataChars) return value;
    complete = false; reasons.add('metadata-unavailable'); return null;
  };
  const bind = values => hash.update(JSON.stringify(values) + '\n');
  bind(['review-effort-v1', ...['id', 'root', 'vcs', 'reviewMode', 'baseRevision', 'targetRevision', 'changeScope'].map(k => field(snapshot[k])), snapshot.files.length]);
  if (typeof snapshot.id !== 'string' || !snapshot.id || typeof snapshot.root !== 'string' || !snapshot.root) {
    complete = false; reasons.add('identity-unavailable');
  }
  if (snapshot.files.length > LIMITS.files) { complete = false; reasons.add('file-limit'); }
  for (let i = 0; i < Math.min(snapshot.files.length, LIMITS.files); i++) {
    const file = snapshot.files[i]; filesScanned++;
    if (!file || typeof file !== 'object') { complete = false; exactChanges = false; reasons.add('source-unavailable'); continue; }
    const path = field(file.path);
    bind([field(file.id), path, field(file.oldPath), field(file.status), field(file.eligibility), field(file.reviewMode)]);
    if (typeof path !== 'string' || !path) { complete = false; reasons.add('identity-unavailable'); }
    if (typeof path === 'string' && PATH_HINT.test(path)) reasons.add('sensitive-path-hint');
    const texts = [];
    for (const side of ['left', 'right']) {
      const source = file[side];
      bind([side, field(source?.exists), field(source?.hash), field(source?.encoding)]);
      const text = source?.text;
      if (typeof text !== 'string' || text.length > LIMITS.sourceChars || used + text.length > LIMITS.totalSourceChars) {
        complete = false; exactChanges = false; reasons.add(typeof text === 'string' ? 'source-limit' : 'source-unavailable');
        texts.push(null); continue;
      }
      used += text.length; bind([text]); texts.push(text);
    }
    if (texts.includes(null)) continue;
    const diff = lineDiff(texts[0], texts[1], { maxCells: 10000 });
    if (diff.status === 'unchanged') continue;
    if (diff.status !== 'changed' || diff.precision !== 'exact') { exactChanges = false; reasons.add('change-scope-unavailable'); continue; }
    // Only exact added/removed lines drive escalation, never an unchanged keyword elsewhere.
    for (const edit of diff.edits) for (const text of [edit.removed, edit.added]) {
      for (const [category, rule] of Object.entries(CATEGORIES)) if (rule.pattern.test(text)) categories.add(category);
    }
  }
  for (const category of categories) reasons.add('changed-' + category);
  if (!reasons.size) reasons.add('standard-baseline');
  const tier = mode === 'auto' ? (categories.size || !complete || !exactChanges ? 'deep' : 'standard') : mode;
  const sensitive = categories.has('sensitive') || reasons.has('sensitive-path-hint');
  return {
    version: 1, status: 'planned', mode, tier, reasons: [...reasons].sort(),
    checks: [...BASELINE, ...[...categories].sort().map(category => CATEGORIES[category].guidance)],
    counterVerification: {
      eligible: tier === 'deep', severities: ['high', 'critical'], requiresFreshEvidence: true,
      categories: [...categories].sort(), guidance: [...categories].sort().map(category => CATEGORIES[category].guidance),
      instructions: 'Attach these counterevidence questions to the primary review without another planning call. For high/critical candidates only, use a separate fresh verifier against exact captured evidence; do not downgrade or clear evidence merely because a counterexample was suggested.',
    },
    humanReview: { required: sensitive, advisoryOnly: true, approvalGranted: false },
    identity: { snapshotIdHash: typeof snapshot.id === 'string' && snapshot.id.length <= LIMITS.metadataChars ? digest(snapshot.id) : null,
      sourceFingerprint: complete ? hash.digest('hex') : null, complete, scope: 'captured-file-sources-and-selected-metadata', reusableCoverage: false },
    scan: { filesScanned, totalFiles: snapshot.files.length, complete: complete && exactChanges, limits: { ...LIMITS } },
  };
}
