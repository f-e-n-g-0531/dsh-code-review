// Synthetic public fixtures only; expectations never belong in model payloads.
export const interactionCases = [
 { id: 'contract-regression', expectation: 'introduced', trigger: 'lookup returns missing', files: [
  { path: 'lookup.js', old: 'export function lookup() { return null; }', new: 'export function lookup() { return undefined; }' },
  { path: 'caller.js', old: "import { lookup } from './lookup.js';\nexport function label() { const value = lookup(); return value == null ? 'missing' : value.name; }", new: "import { lookup } from './lookup.js';\nexport function label() { const value = lookup(); return value === null ? 'missing' : value.name; }" }
 ] },
 { id: 'contract-safe-counterexample', expectation: 'no-defect', trigger: 'lookup returns missing', files: [
  { path: 'lookup.js', old: 'export function lookup() { return null; }', new: 'export function lookup() { return undefined; }' },
  { path: 'caller.js', old: "import { lookup } from './lookup.js';\nexport function label() { const value = lookup(); return value == null ? 'missing' : value.name; }", new: "import { lookup } from './lookup.js';\nexport function label() { const value = lookup(); return value === undefined ? 'missing' : value.name; }" }
 ] }
];
