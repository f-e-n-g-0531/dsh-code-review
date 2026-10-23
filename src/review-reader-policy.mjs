const FIXED_CALLS = 50;
const FIXED_OUTPUT_BYTES = 256 * 1024;
const CALL_CAP = 1000;
const OUTPUT_CAP = 4 * 1024 * 1024;

// Host policy only. Derive once for the approved review and use the same limits
// for its single reader across files, planning, generation and verification.
// This changes neither low-level reader defaults nor approved source authority.
export function reviewReaderBudget(snapshot, policy = 'fixed') {
  if (policy !== 'fixed' && policy !== 'scaled') throw new Error('Invalid review reader policy');
  if (policy === 'fixed') return { maxCalls: FIXED_CALLS, maxOutputBytes: FIXED_OUTPUT_BYTES };
  if (!snapshot || !Array.isArray(snapshot.files)) throw new Error('Invalid review reader snapshot');
  let reviewable = 0;
  for (const file of snapshot.files) {
    if (!file || !['reviewable', 'excluded', 'blocked'].includes(file.eligibility)) throw new Error('Invalid review reader file');
    if (file.eligibility === 'reviewable') reviewable++;
  }
  return {
    maxCalls: Math.min(CALL_CAP, Math.max(FIXED_CALLS, reviewable * 4)),
    maxOutputBytes: Math.min(OUTPUT_CAP, Math.max(FIXED_OUTPUT_BYTES, reviewable * 16 * 1024)),
  };
}

// Admission is not a reservation or evidence check. An admitted request still
// shares the reader's live call/output ledger and exact per-result limits.
// A full-body/window primary can proceed without new reads; metadata-only
// synthesis/interaction and hidden-context primaries cannot do useful work when
// the approved reader is already exhausted. Never inspect source text here.
export function readerAdmission(prepared, remaining) {
  if (!prepared || typeof prepared !== 'object' || Array.isArray(prepared)) return { permitted: false, code: 'READER_BUDGET_UNAVAILABLE' };
  const metadata = prepared.metadata;
  const mode = prepared.sourceMode ?? metadata?.sourceMode;
  const required = prepared.hasRequiredRetrieval === true || prepared.synthesis === true || prepared.interaction === true ||
    mode === 'window-synthesis' || mode === 'file-interaction' ||
    prepared.contextMode === 'approved-retrieval' || metadata?.contextMode === 'approved-retrieval';
  if (!required) return { permitted: true };
  const calls = remaining?.remainingCalls, bytes = remaining?.remainingOutputBytes;
  if (!Number.isSafeInteger(calls) || !Number.isSafeInteger(bytes)) return { permitted: false, code: 'READER_BUDGET_UNAVAILABLE' };
  if (calls <= 0) return { permitted: false, code: 'READER_CALL_BUDGET_EXCEEDED' };
  if (bytes <= 0) return { permitted: false, code: 'READER_OUTPUT_BUDGET_EXCEEDED' };
  return { permitted: true };
}
