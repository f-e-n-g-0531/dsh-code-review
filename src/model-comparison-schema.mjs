// Result data only. This schema grants no source access or host-validated relation.
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const reason = description => ({ type: 'string', minLength: 1, maxLength: 8000, description });
const indices = role => ({
  type: 'array', minItems: 1, maxItems: 8,
  items: { type: 'integer', minimum: 0, maximum: 7 },
  description: role + ': 1..8 distinct zero-based indices (0..7) into this candidate current-invocation evidence array. No duplicates. Copy actual evidence indices, never source identities, paths or read requests. Bounds and uniqueness remain host-validator requirements when transport strips constraints.',
});

/** Fresh mutable schema per call; not wired into default strict comparison. */
export function buildModelComparisonSchema() {
  return object({
    classification: { type: 'string', enum: ['introduced', 'preexisting', 'uncertain'], description: 'Model-assessed comparison classification only; not host-proven causality or the legacy strict introduced-support status.' },
    reason: reason('Nonblank comparison explanation, at most 8000 characters. Model assessment is not source evidence or permission.'),
    comparison: object({
      kind: { type: 'string', const: 'model-assessed-cross-file' },
      roles: object({
        oldEntry: indices('Complete old public entry'),
        oldDelegate: indices('Complete old delegated implementation'),
        newEntry: indices('Complete new public entry'),
        newDelegate: indices('Optional complete new delegated implementation; omit when not applicable'),
        callers: indices('Applicable captured caller implementations'),
      }, ['oldEntry', 'oldDelegate', 'newEntry', 'callers']),
      relationshipReason: reason('Supplemental exact evidence may remain outside role indices and does not supply role coverage. Nonblank explanation of the model-assessed role relationships under the same trigger, at most 8000 characters; no host-contract or independently proven relationship is implied.'),
    }),
  });
}
