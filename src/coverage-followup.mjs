// Advisory only: never executes a review or carries approval to another snapshot.
export function coverageFollowup(report) {
  if (!report || typeof report.snapshotId !== 'string' || !report.snapshotId || !Array.isArray(report.files) || report.files.length > 200 || !Array.isArray(report.findings)) throw new Error('Invalid coverage report');
  const ids = new Set(), paths = new Set();
  const items = report.files.map(file => {
    if (!file || typeof file.fileId !== 'string' || !file.fileId || ids.has(file.fileId) || typeof file.path !== 'string' || !file.path || paths.has(file.path) || !['completed', 'excluded', 'blocked', 'failed', 'cancelled', 'pending'].includes(file.status)) throw new Error('Invalid coverage file');
    ids.add(file.fileId); paths.add(file.path);
    const incompleteVerification = report.findings.some(f => f.fileId === file.fileId && ['pending', 'incomplete'].includes(f.verification?.status));
    return { fileId: file.fileId, path: file.path, status: file.status, incompleteVerification,
      followup: file.status !== 'excluded' && (file.status !== 'completed' || incompleteVerification) };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { snapshotId: report.snapshotId, requiresNewPreview: true, requiresApproval: true, items,
    suggestedPaths: items.filter(item => item.followup).map(item => item.path) };
}
