// Single-pass only. These are model declarations, never proof of source coverage.
const fail = () => { throw Object.assign(new Error('Invalid single-pass completion response'), { code: 'SINGLE_PASS_PROTOCOL_FAILED' }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = value => Array.isArray(value) && value.length <= 50 && value.every(text => typeof text === 'string' && text.trim() && text.length <= 8000);
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));

function declaration(value) {
  if (value === undefined) return { status: 'needs-classification', gaps: [] };
  if (!keys(value, ['status', 'gaps']) || !['completed', 'incomplete'].includes(value.status) || !strings(value.gaps)) fail();
  if ((value.status === 'completed') !== (value.gaps.length === 0)) fail();
  return { status: value.status, gaps: [...value.gaps] };
}

function details(value) {
  if (!strings(value.limitations) || (value.assuranceNotes !== undefined && !strings(value.assuranceNotes))) fail();
  const completion = declaration(value.completion);
  return { completion, assuranceNotes: [...(value.assuranceNotes ?? [])], limitations: [...value.limitations], complete: completion.status === 'completed' && value.limitations.length === 0 };
}

// Validate every identity and every completion field before any candidate can be
// published. The projected envelope still goes through the ordinary host finding
// and exact-anchor validators; declarations cannot bypass a failed member.
export function normalizeSinglePassCompletion(response, fileIds) {
  const serialized = typeof response === 'string' ? response : JSON.stringify(response);
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > 128 * 1024) fail();
  const value = typeof response === 'string' ? JSON.parse(response) : response;
  if (!keys(value, ['reviews', 'limitations', 'completion', 'assuranceNotes']) || !Array.isArray(value.reviews) || value.reviews.length !== fileIds.length) fail();
  const expected = new Set(fileIds), members = new Map();
  // Identity admission is global, independent of completion declarations.
  for (const row of value.reviews) {
    if (!keys(row, ['fileId', 'findings', 'limitations', 'completion', 'assuranceNotes']) || !expected.has(row.fileId) || members.has(row.fileId)) fail();
    members.set(row.fileId, null);
  }
  const global = details(value);
  for (const row of value.reviews) members.set(row.fileId, details(row));
  return {
    response: { reviews: value.reviews.map(({ fileId, findings, limitations }) => ({ fileId, findings, limitations })), limitations: [...value.limitations] },
    global, members,
    complete: global.complete && [...members.values()].every(member => member.complete),
  };
}

export function singlePassCompletionLimitations(detail, fileId) {
  const identity = fileId === undefined ? {} : { fileId };
  return [
    ...detail.limitations.map(text => ({ ...identity, code: 'SINGLE_PASS_LEGACY_NEEDS_CLASSIFICATION', text })),
    ...detail.completion.gaps.map(text => ({ ...identity, code: 'SINGLE_PASS_SCOPE_GAP', text })),
    ...(detail.completion.status === 'needs-classification' ? [{ ...identity, code: 'SINGLE_PASS_COMPLETION_UNDECLARED', text: '模型未提供结构化完成声明，静态审核范围完成情况待分类。' }] : []),
  ];
}
