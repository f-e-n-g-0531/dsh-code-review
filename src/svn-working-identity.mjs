import { hash } from './content.mjs';
import { sameSvnUrl, canonicalSvnUrl } from './svn-url.mjs';

export function svnWorkingIdentity(node, rootInfo, name) {
  const expected = name === '.'
    ? rootInfo.url
    : rootInfo.url.replace(/\/$/, '') + '/' + name.split('/').map(encodeURIComponent).join('/');

  if (!sameSvnUrl(node?.url, expected)) throw Object.assign(new Error('SVN node URL differs from selected working-copy path; switched ancestors are unsupported'), { code: 'SVN_SWITCHED_ANCESTOR' });
  if (!rootInfo.repository?.uuid || node.repository?.uuid !== rootInfo.repository.uuid || node.repository?.root !== rootInfo.repository.root || node['wc-info']?.['wcroot-abspath'] !== rootInfo['wc-info']?.['wcroot-abspath']) throw Object.assign(new Error('SVN node repository or working-copy identity mismatch'), { code: 'SVN_NODE_IDENTITY' });

  const source = {
    url: canonicalSvnUrl(node.url),
    repositoryUuid: node.repository.uuid,
    repositoryRoot: node.repository.root,
    revision: String(node['@_revision']),
    kind: node['@_kind'],
    ...(node['@_kind'] === 'dir' ? { depth: node['wc-info']?.depth ?? null } : {}),
    schedule: node['wc-info']?.schedule,
    copyFromUrl: node['wc-info']?.['copy-from-url'] ?? null,
    copyFromRevision: node['wc-info']?.['copy-from-rev'] ?? null,
  };
  return { source, fingerprint: hash(JSON.stringify(source)) };
}
