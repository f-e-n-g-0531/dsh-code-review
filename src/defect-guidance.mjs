// Original defect checklists, not executable rules or proof of a defect.
const common = ['Only report a concrete defect with trigger, impact and changed-code evidence.', 'Check before/after behavior and counterexamples; absent context means uncertainty, not an invented contract.'];
const checklists = {
 cpp: ['Check ownership, dangling references, double release and allocator/object lifetime across all exits.', 'Check stop publication, synchronization, join completion and remaining users before teardown; source order alone is not a happens-before proof.', 'Check exception/early-return resource cleanup, iterator invalidation, bounds, integer conversion and undefined behavior.', 'Do not assume macro expansion, overload binding, build flags or virtual dispatch targets without evidence.'],
 csharp: ['Check IDisposable/async disposal, cancellation propagation and completion before releasing shared state.', 'Check nullability and actual runtime guards, event subscription lifetime, deferred enumeration and captured mutable state.', 'Check async exception observation, synchronization and thread-affinity; do not assume await establishes unrelated ordering.'],
 javascript: ['Check null/undefined contract changes, promise rejection handling and missing await or cleanup on failure.', 'Check event/timer/listener lifecycle, closure state, cancellation races and concurrent updates.', 'Check untrusted input at injection/authentication boundaries; do not report style or infer TypeScript runtime checks.'],
 configuration: ['Check changed configuration keys against consumer/schema evidence, type/unit/default mismatches and compatibility.', 'Check exposed secrets, privilege expansion and unsafe interpolation only with concrete supported evidence.']
};
export function defectGuidance(filePath) {
 const lower = filePath.toLowerCase();
 const language = /\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/.test(lower) ? 'cpp' : lower.endsWith('.cs') ? 'csharp' : /\.(js|jsx|mjs|cjs|ts|tsx)$/.test(lower) ? 'javascript' : /\.(json|yaml|yml|toml|ini|xml|properties)$/.test(lower) ? 'configuration' : 'generic';
 return { version:1, language, checks:[...common,...(checklists[language] ?? [])], notice:'Guidance is not evidence, a semantic parser, a style rule or permission to read outside the snapshot.' };
}
