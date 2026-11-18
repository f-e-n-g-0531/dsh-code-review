import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

const measurement = new AsyncLocalStorage();
const phaseRecord = () => ({ elapsedMs: 0, commands: 0, treeQueries: 0, metadataStdoutBytes: 0, sourceStdoutBytes: 0, localSourceBytes: 0 });

// Host-only observation: no paths, commands, arguments, IDs, or source text.
// Counters cover instrumented adapter calls, not subprocess internals or all
// filesystem I/O. Bytes describe successful stdout/local source reads only.
export async function measureSnapshotCapture(capture) {
  const phases = Object.create(null);
  const snapshot = await measurement.run({ phases }, () => capture());
  return { snapshot, metrics: { phases } };
}

export async function snapshotCapturePhase(name, execute) {
  const state = measurement.getStore();
  if (!state) return execute();
  const phase = state.phases[name] ??= phaseRecord();
  const start = performance.now();
  try {
    return await measurement.run({ phases: state.phases, phase }, execute);
  } finally {
    phase.elapsedMs += performance.now() - start;
  }
}

export async function measureSnapshotCommand(execute, kind) {
  const phase = measurement.getStore()?.phase;
  if (!phase) return execute();
  phase.commands++;
  if (kind === 'tree') phase.treeQueries++;
  const result = await execute();
  const bytes = Buffer.isBuffer(result) ? result : result.code === 0 ? result.stdout : undefined;
  if (bytes) phase[kind === 'source' ? 'sourceStdoutBytes' : 'metadataStdoutBytes'] += bytes.length;
  return result;
}

export async function measureSnapshotLocalSource(execute) {
  const phase = measurement.getStore()?.phase;
  const result = await execute();
  if (phase) phase.localSourceBytes += result.bytes;
  return result;
}
