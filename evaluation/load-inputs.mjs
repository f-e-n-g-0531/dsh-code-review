import { readLocal, relativePath, hash } from '../src/content.mjs';

// Local preparation only; no executable sample imports, model calls or approval.
export async function loadEvaluationInputs(root, sample, { signal } = {}) {
  const inputs = structuredClone(sample?.inputs);
  if (!Array.isArray(inputs) || inputs.length !== 3) throw new Error('Invalid evaluation inputs');
  const roles = ['before', 'after', 'context'];
  const paths = new Set();
  for (const [i, input] of inputs.entries()) {
    if (!input || input.role !== roles[i] || typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.sha256)) throw new Error('Invalid evaluation input');
    relativePath(input.path);
    if (paths.has(input.path) || !(i === 2 ? input.path.endsWith('/contract.txt') : input.path.endsWith('.mjs'))) throw new Error('Invalid evaluation input path');
    paths.add(input.path);
  }
  const result = {};
  for (const input of inputs) {
    const content = await readLocal(root, input.path, { maxFileBytes: 16384, signal });
    if (content.encoding !== 'utf-8') throw new Error('Evaluation inputs must be UTF-8');
    const text = content.text.replaceAll('\r\n', '\n');
    if (hash(text) !== input.sha256) throw new Error('Evaluation input hash mismatch');
    result[input.role] = { text, sha256: input.sha256 };
  }
  signal?.throwIfAborted();
  return result;
}
