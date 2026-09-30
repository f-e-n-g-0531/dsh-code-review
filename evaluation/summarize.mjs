// Aggregates supplied human adjudications; never judges model findings itself.
// Each row is one single-target case in one phase/run. Keep runs separate.
export function summarizeEvaluation(rows) {
  if (!Array.isArray(rows) || rows.length > 200) throw new Error('Invalid evaluation rows');
  const counts = { hit: 0, miss: 0, falsePositive: 0, clean: 0, uncertain: 0, failed: 0, incomplete: 0 };
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row.id !== 'string' || !row.id || seen.has(row.id) || typeof row.expectedRegression !== 'boolean' || typeof row.outcome !== 'string' || !Object.hasOwn(counts, row.outcome)) throw new Error('Invalid evaluation row');
    if (['hit', 'miss'].includes(row.outcome) && !row.expectedRegression || ['falsePositive', 'clean'].includes(row.outcome) && row.expectedRegression) throw new Error('Inconsistent evaluation adjudication');
    seen.add(row.id); counts[row.outcome]++;
  }
  const decided = counts.hit + counts.miss + counts.falsePositive + counts.clean;
  return { total: rows.length, decided, unresolved: rows.length - decided, counts,
    positiveCasesDecided: counts.hit + counts.miss,
    negativeCasesDecided: counts.falsePositive + counts.clean,
    // Null denominators are not zero-percent success or perfect accuracy.
    decidedCaseRecall: counts.hit + counts.miss ? counts.hit / (counts.hit + counts.miss) : null,
    decidedNegativeFalsePositiveRate: counts.falsePositive + counts.clean ? counts.falsePositive / (counts.falsePositive + counts.clean) : null,
    scope: 'single-target-case-adjudications-only' };
}
