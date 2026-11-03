// Preview validity is diagnostic only: it never restores approval or bypasses recapture.
export function previewValidity(preview, current, now) {
  const fail = (code, message) => { const error = new Error(message + '; preview again and verify current explicit user authorization; do not reuse old approval. A matching explicit review request needs no duplicate confirmation; preview-only or explicit wait-for-confirmation does not authorize execution, and scope/model/destination changes require authorization'); error.code = code; throw error; };
  if (!preview) fail('PREVIEW_MISSING', 'Preview missing or already consumed');
  if (preview.expires <= now) fail('PREVIEW_EXPIRED', 'Preview expired');
  if (preview.agent !== current.agent) fail('PREVIEW_OWNER_CHANGED', 'Preview owner changed');
  if (preview.cwd !== current.cwd) fail('PREVIEW_DIRECTORY_CHANGED', 'Preview directory changed');
  if (JSON.stringify(preview.route) !== JSON.stringify(current.route)) fail('PREVIEW_MODEL_CHANGED', 'Preview model changed');
}
