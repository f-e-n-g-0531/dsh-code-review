import { loadEvaluationInputs } from './load-inputs.mjs';
import { hash } from '../src/content.mjs';

// In-memory synthetic adapter, not a VCS capture or an authorization grant.
export async function prepareEvaluationSnapshot(root, sample, options) {
  const input = await loadEvaluationInputs(root, sample, options);
  const content = value => ({ text: value.text, hash: value.sha256, encoding: 'utf-8', bytes: Buffer.byteLength(value.text) });
  const payload = {
    vcs: 'git', // Git-shaped comparison only; not captured from a repository.
    origin: 'synthetic-evaluation',
    files: [{ id: 'f1', path: 'subject.mjs', eligibility: 'reviewable', leftExists: true, rightExists: true,
      left: content(input.before), right: content(input.after), properties: [] }],
    context: [{ path: 'contract.txt', ...content(input.context) }],
    rules: []
  };
  return { id: hash(JSON.stringify(payload)), ...payload };
}
