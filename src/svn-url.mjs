// Compare repository URL spelling without decoding path separators into structure.
const SAFE_PROTOCOLS = ['file:', 'http:', 'https:', 'svn:', 'svn+ssh:'];
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

export function canonicalSvnUrl(value) {
  if (typeof value !== 'string') throw new Error('Missing SVN URL');
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || !SAFE_PROTOCOLS.includes(url.protocol)) throw new Error('Unsafe SVN URL identity');
  const segments = url.pathname.split('/').map(segment => {
    const decoded = decodeURIComponent(segment);
    if (decoded.includes('/') || decoded.includes('\\') || CONTROL_CHARS.test(decoded) || decoded === '.' || decoded === '..') throw new Error('Unsafe encoded SVN URL segment');
    return encodeURIComponent(decoded);
  });
  return url.protocol + '//' + url.host + segments.join('/').replace(/\/$/, '');
}

export function sameSvnUrl(a, b) {
  try { return canonicalSvnUrl(a) === canonicalSvnUrl(b); }
  catch { return false; }
}
