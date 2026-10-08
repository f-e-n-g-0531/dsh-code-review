// Called after ordinary snapshot/attribution validation, before accepting batch findings.
export function validateWindowFindings(findings, windows) {
  const edits = new Set(windows.flatMap(w => w.editIds));
  for (const finding of findings) {
    const attribution = finding.attribution;
    if (attribution.status !== 'references-validated' || !attribution.editIds?.length || attribution.editIds.some(id => !edits.has(id))) throw new Error('Finding outside current window edits');
    const anchor = finding.anchor;
    if (anchor.kind === 'line' && !windows.some(w => {
      const range = w[anchor.side];
      return range && range.count > 0 && anchor.start >= range.start && anchor.end < range.start + range.count;
    })) throw new Error('Finding anchor outside current windows');
  }
}
