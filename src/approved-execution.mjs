import { reviewOwner, ownerGuard, sameReviewOwner } from './review-owner.mjs';
import { previewValidity } from './preview-validity.mjs';

export function validateApprovedExecutionArgs(args) {
  if (!args || Array.isArray(args) || args.confirmed !== true || typeof args.previewId !== 'string' || Object.keys(args).some(key => key !== 'previewId' && key !== 'confirmed')) throw new Error('Confirmed preview is required');
}

// Consume only after verifying current ownership. No approval is transferred
// from a previous job or inferred from the existence of a preview.
export async function consumeApprovedPreview(args, exec, { previews, resolveCwd, now, signal }) {
  validateApprovedExecutionArgs(args);
  signal?.throwIfAborted();
  const current = await reviewOwner(exec, resolveCwd);
  signal?.throwIfAborted();
  const preview = previews.get(args.previewId);
  try { previewValidity(preview, current, now()); }
  catch (error) { if (error.code === 'PREVIEW_EXPIRED') previews.delete(args.previewId); throw error; }
  previews.delete(args.previewId);
  return { preview, current };
}

// Read-only diagnosis of a live lease; execution still requires recapture and authorization.
export async function checkPreviewAvailability(previewId, exec, { previews, resolveCwd, now }) {
  exec?.signal?.throwIfAborted();
  if (!previews.has(previewId)) return 'unavailable';
  try {
    const current = await reviewOwner(exec, resolveCwd);
    exec?.signal?.throwIfAborted();
    const preview = previews.get(previewId);
    if (!preview || !sameReviewOwner(preview, current)) return 'unavailable';
    previewValidity(preview, current, now());
    return 'available';
  } catch (error) {
    exec?.signal?.throwIfAborted();
    return error?.code === 'PREVIEW_EXPIRED' ? 'expired' : 'unavailable';
  }
}

export async function authorizeApprovedSnapshot({ snapshot, preview, exec, authorize, resolveCwd, signal }) {
  signal?.throwIfAborted();
  if (await authorize({ snapshot, route: preview.route, exec }) !== true) throw new Error('Model sending approval denied or unavailable');
  signal?.throwIfAborted();
  await ownerGuard(exec, resolveCwd, preview, 'Agent changed during approval')();
  signal?.throwIfAborted();
  return ownerGuard(exec, resolveCwd, preview);
}
