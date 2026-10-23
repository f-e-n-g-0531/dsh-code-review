// Admit only ready chains. Dependencies point to earlier input positions, never workers.
export async function scheduleFileChains(indices, run, dependencies, concurrency) {
  const pending = [...indices], settled = new Set(), active = new Map();
  let failed = false, failure;
  const start = index => {
    const promise = Promise.resolve().then(() => run(index)).catch(error => { if (!failed) { failed = true; failure = error; } }).finally(() => { settled.add(index); active.delete(index); });
    active.set(index, promise);
  };
  while (pending.length || active.size) {
    while (!failed && active.size < concurrency) {
      const position = pending.findIndex(index => (dependencies.get(index) ?? []).every(dep => !indices.includes(dep) || settled.has(dep)));
      if (position < 0) break;
      start(pending.splice(position, 1)[0]);
    }
    if (!active.size) {
      if (failed) break;
      if (pending.length) throw new Error('Unresolvable file review dependency');
    } else await Promise.race(active.values());
  }
  // Rejections never abandon sibling cleanup or release the service lock early.
  await Promise.all(active.values());
  if (failed) throw failure;
}
