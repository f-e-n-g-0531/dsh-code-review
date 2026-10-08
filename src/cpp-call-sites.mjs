// Syntactic zero-argument lifecycle call navigation only, not resolved bindings.
export function cppCallSites(text) {
 if (typeof text !== 'string' || Buffer.byteLength(text) > 256*1024 || /\/\*|R"|\\\r?\n/.test(text)) return [];
 const lines = text.split(String.fromCharCode(10));
 if (lines.some(line => /^\s*#\s*(?:define|undef|if|ifdef|ifndef|elif|else|endif)\b/.test(line))) return [];
 const sites = [];
 for (let i=0;i<lines.length;i++) {
  const match = /^\s*((?:[A-Za-z_][A-Za-z0-9_]*(?:::|->|\.))*[A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)\s*;\s*(?:\/\/.*)?$/.exec(lines[i]);
  if (!match) continue;
  sites.push({ line:i+1, expression:match[1], confidence:'syntax-only-unresolved', notice:'May be macro, overload or dynamic dispatch; no binding or order guarantee.' });
  if (sites.length === 20) break;
 }
 return sites;
}
