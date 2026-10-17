import { relativePath } from './content.mjs';
import { assertNonSecretPath } from './secret-path.mjs';

// Cross-branch endpoints are repository-relative paths, never arbitrary URLs.
export function svnHistoryEndpoints(local, options, destination) {
  const hasBase = options.svnBasePath !== undefined, hasTarget = options.svnTargetPath !== undefined;
  if (hasBase !== hasTarget) throw new Error('SVN branch comparison requires both svnBasePath and svnTargetPath');
  if (!hasBase) return { baseUrl: destination(local.url, options.svnAllowNetwork).url, targetUrl: destination(local.url, options.svnAllowNetwork).url, crossUrl: false };
  if (options.svnRevision !== undefined) throw new Error('SVN branch paths require explicit revision range');
  if (!local.repository?.root || !local.repository?.uuid) throw new Error('SVN repository root identity required');

  const endpoint = value => {
    if (value !== '.') { relativePath(value); assertNonSecretPath(value); }
    const root = destination(local.repository.root, options.svnAllowNetwork).url;
    return value === '.' ? root : root + '/' + value.split('/').map(encodeURIComponent).join('/');
  };

  const baseUrl = endpoint(options.svnBasePath), targetUrl = endpoint(options.svnTargetPath);
  if (baseUrl !== targetUrl && (baseUrl.startsWith(targetUrl + '/') || targetUrl.startsWith(baseUrl + '/'))) throw new Error('Overlapping SVN branch roots require unambiguous endpoint path mapping');
  return { baseUrl, targetUrl, crossUrl: baseUrl !== targetUrl };
}
