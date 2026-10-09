import { assertNonSecretPath } from './secret-path.mjs';
import { readLocal, relativePath } from './content.mjs';

// Explicit paths only. This helper neither authorizes sending nor follows includes.
export async function captureProjectRules(root, paths, { signal, files = [], read = readLocal } = {}) {
  if (!Array.isArray(paths) || paths.length > 4) throw new Error('Rule file limit exceeded');
  const seen = new Set();
  for (const name of paths) {
    relativePath(name);
    assertNonSecretPath(name);
    if (!/[.](md|txt)$/i.test(name)) throw new Error('Rules must be Markdown or text');
    if (seen.has(name)) throw new Error('Duplicate rule path');
    seen.add(name);
    const changed = files.find(file => file.path === name);
    if (changed && (changed.eligibility !== 'reviewable' || changed.rightExists === false)) throw new Error('Rule path is excluded, blocked or deleted');
  }
  const rules = [];
  let bytes = 0;
  for (const name of [...paths].sort()) {
    const content = await read(root, name, { signal, maxFileBytes: 16 * 1024 });
    if (content.encoding !== 'utf-8') throw new Error('Rules must use UTF-8');
    bytes += content.bytes;
    if (bytes > 32 * 1024) throw new Error('Rule content budget exceeded');
    rules.push({ path: name, ...content });
  }
  return rules;
}
