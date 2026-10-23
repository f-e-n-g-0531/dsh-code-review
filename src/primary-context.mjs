// Pure transport selection over approved snapshot context. This never captures,
// reads, removes catalog authority, truncates bodies or claims context coverage.
export function primaryContextFocus(base, { scope, maxInputBytes, measure }) {
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1 || typeof measure !== 'function') throw new Error('Invalid primary context budget');
  const contexts = base.context ?? [];
  if (!scope || !contexts.length) return { base, metadata: {} };
  const contextCatalog = scope.catalog().filter(source => ['context', 'context-old'].includes(source.side));
  const linked = new Set();
  for (const relation of base.contextRelations ?? []) {
    if (relation.fromPath === base.file.path) linked.add(relation.toPath);
    if (relation.toPath === base.file.path) linked.add(relation.fromPath);
  }
  for (const caller of base.callerBindings ?? []) linked.add(caller.fromPath);
  for (const hint of base.csharpContextHints ?? []) if (hint.primaryPath === base.file.path) linked.add(hint.contextPath);
  const envelope = context => {
    const deferred = context.length < contexts.length;
    return { ...base, context, contextCatalog,
      ...(deferred ? { contextMode: 'approved-retrieval', contextNotice: 'Only focused approved context bodies are provided. Other catalog identities require version-specific read; omission is not absence or reviewed coverage.' } : {}),
    };
  };
  const selected = [];
  const bodyBudget = Math.min(16 * 1024, Math.floor(maxInputBytes / 4));
  for (const context of contexts) {
    if (!linked.has(context.path)) continue;
    // Only catalog-approved bodies qualify, with each historical side retained
    // together in its original object. No target-for-old substitution.
    const sources = contextCatalog.filter(source => source.path === context.path);
    if (typeof context.text === 'string' && !sources.some(source => source.side === 'context') || typeof context.oldText === 'string' && !sources.some(source => source.side === 'context-old') || !sources.length) continue;
    const proposed = [...selected, context];
    if (Buffer.byteLength(JSON.stringify(proposed)) > bodyBudget || !measure(JSON.stringify(envelope(proposed))).fits) continue;
    selected.push(context);
  }
  const deferred = contexts.length - selected.length;
  return { base: envelope(selected), metadata: { contextProvidedCount: selected.length, contextDeferredCount: deferred, ...(deferred ? { contextMode: 'approved-retrieval' } : {}) } };
}
