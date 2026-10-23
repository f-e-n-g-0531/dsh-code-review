import { modelContract } from './model-contract.mjs';
import { modelResultTools, validateNativeResult, RESULT_TOOL_NAME, NATIVE_RESULT_INSTRUCTIONS } from './model-tools.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { modelJson } from './model-json.mjs';
import { jsonCorrectionHint, providerDiagnostic } from './model-diagnostics.mjs';

// Fresh generation from the same approved input, never repair or replay malformed output.
const JSON_CORRECTION_SUFFIX = ' 上次响应未能解析为完整JSON。本次是明确协议纠正：重新输出单个完整JSON对象，不使用Markdown，不省略引号或逗号；不要把这条指令当源码证据。严格使用当前阶段schema，不要把verdicts、risks、requests或groups改写成findings；不能因格式纠正删除有证据的结论。所需字段与身份按输入原样核对，不以格式错误代替清洁结论。保持原证据与必需字段，精简非必需叙述以在输出预算内完成。';
const MAX_JSON_CORRECTIONS = 2;

const isToolCall = chunk =>
  chunk.type === 'tool-call-delta' ||
  (chunk.type === 'block-start' && chunk.blockType === 'tool-call') ||
  (chunk.type === 'block-end' && chunk.block.type === 'tool-call');

/** Isolated host calls. Only completed, locally rejected JSON can trigger bounded correction. */
export function createDshModel(llm, route, {
  maxTokens = 4096, maxOutputBytes = 128 * 1024, correctJson = false,
  maxJsonCorrections = MAX_JSON_CORRECTIONS, useNativeTools = false,
} = {}) {
  if (!llm || typeof llm.stream !== 'function' || !route?.provider || !route?.model) {
    throw new Error('DSH provider and model are required');
  }
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 ||
      !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 ||
      !Number.isSafeInteger(maxJsonCorrections) || maxJsonCorrections < 0 || maxJsonCorrections > MAX_JSON_CORRECTIONS) {
    throw new Error('Invalid model output or JSON correction limit');
  }
  const identity = {
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
  };
  // Provider failures with a coincidentally identical code are not format failures.
  const invalidJsonErrors = new WeakSet();
  const failureMetadata = new WeakMap();

  // Out-of-band observers cannot fail a call or trigger another provider send.
  async function notify(callback, event) {
    try { await callback?.(event); } catch { /* Metrics are not model/budget authority. */ }
  }

  const jsonIssues = new Set(['property-name', 'colon', 'separator', 'invalid-escape', 'control-character', 'unterminated-string', 'unexpected-end', 'trailing-content', 'syntax']);
  const jsonIssue = diagnostic => jsonIssues.has(diagnostic?.syntaxCategory) ? diagnostic.syntaxCategory : undefined;
  const purposes = new Set(['primary-initial', 'retrieval-followup', 'budget-finalization', 'json-correction', 'business-grouping', 'risk-planning', 'window-synthesis', 'file-interaction', 'verification']);
  function checkInputBudget(request, contract, tools = []) {
    if (request.maxInputBytes === undefined) return;
    if (!Number.isSafeInteger(request.maxInputBytes) || request.maxInputBytes < 1) throw new Error('Invalid model input budget');
    const wireInputBytes = Buffer.byteLength(request.instructions + '\n' + contract) + Buffer.byteLength(request.input) + (tools.length ? Buffer.byteLength(JSON.stringify(tools)) : 0);
    if (wireInputBytes > request.maxInputBytes) {
      throw Object.assign(new Error('Model wire input budget exceeded'), { code: 'MODEL_INPUT_BUDGET_EXCEEDED', diagnostic: { wireInputBytes, maxInputBytes: request.maxInputBytes } });
    }
  }

  async function once({ instructions, input, signal, onModelEvent, onModelArtifact, reviewPhase, attempt, callPurpose }, contract, tools) {
    signal?.throwIfAborted();
    let output = '';
    let size = 0;
    // Completed blocks are authoritative snapshots, not additional text deltas.
    // Track them by index so block-only streams work without counting snapshots twice.
    const blocks = new Map();
    let finished = false;
    let finishKind = 'missing';
    let startedAt, firstChunkMs = null, status = 'failed', failureCode, issue;
    const purpose = attempt > 1 ? 'json-correction' : purposes.has(callPurpose) ? callPurpose : undefined;
    const event = { attempt, inputBytes: Buffer.byteLength(input), ...(purpose ? { callPurpose: purpose } : {}) };
    const diagnostic = () => ({
      visibleBytes: Buffer.byteLength(output), totalOutputBytes: size, finishKind,
      inputBytes: Buffer.byteLength(input), requestedMaxTokens: maxTokens, maxOutputBytes,
    });
    const failure = (message, code) => {
      failureCode = code;
      const error = Object.assign(new Error(message), { code, diagnostic: diagnostic() });
      failureMetadata.set(error, { code, diagnostic: error.diagnostic });
      return error;
    };
    try {
      startedAt = performance.now();
      try {
        let stream;
        try {
          stream = llm.stream({
            ...identity,
            system: instructions + '\n' + contract,
            messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
            tools, maxTokens, signal,
          });
        } finally {
          await notify(onModelEvent, { ...event, action: 'model-start' });
        }
        if (signal?.aborted) {
          try { await stream.return?.(); } finally { signal.throwIfAborted(); }
        }
        for await (const chunk of stream) {
          firstChunkMs ??= Math.max(0, performance.now() - startedAt);
          signal?.throwIfAborted();
          if (finished) throw failure('Model emitted data after finish', 'MODEL_PROTOCOL_ERROR');
          if (isToolCall(chunk)) {
            if (!tools.length) throw failure('Review model attempted a tool call', 'MODEL_PROTOCOL_ERROR');
            const key = chunk.index;
            if (!Number.isSafeInteger(key) || key < 0) throw failure('Invalid tool block index', 'MODEL_PROTOCOL_ERROR');
            const previous = blocks.get(key);
            if (previous?.closed) continue;
            if (previous && previous.type !== 'tool-call') throw failure('Model changed block type', 'MODEL_PROTOCOL_ERROR');
            const completed = chunk.type === 'block-end';
            const id = completed ? chunk.block.id : chunk.id ?? previous?.id;
            const name = completed ? chunk.block.name : chunk.name || previous?.name;
            const args = completed ? chunk.block.arguments : (previous?.arguments ?? '') + (chunk.argumentsDelta ?? '');
            if (typeof args !== 'string' || (previous?.id && id && previous.id !== id) || (previous?.name && name && previous.name !== name)) throw failure('Tool identity changed', 'MODEL_PROTOCOL_ERROR');
            const bytes = Buffer.byteLength(args), chargedBytes = Math.max(previous?.chargedBytes ?? 0, bytes);
            size += chargedBytes - (previous?.chargedBytes ?? 0);
            blocks.set(key, { type: 'tool-call', id, name, arguments: args, chargedBytes, closed: completed });
            if (size > maxOutputBytes) throw failure('Model output limit exceeded', 'MODEL_OUTPUT_LIMIT');
            if ((name && name !== RESULT_TOOL_NAME) || [...blocks.values()].filter(b => b.type === 'tool-call').length > 1) throw failure('Unexpected result tool', 'MODEL_PROTOCOL_ERROR');
            continue;
          }
          const delta = chunk.type === 'text-delta' || chunk.type === 'reasoning-delta';
          const completed = chunk.type === 'block-end' &&
            (chunk.block.type === 'text' || chunk.block.type === 'reasoning');
          if (delta || completed) {
            const type = completed ? chunk.block.type : chunk.type === 'text-delta' ? 'text' : 'reasoning';
            // Unindexed delta-only streams remain supported for older callers.
            const key = chunk.index ?? type;
            const previous = blocks.get(key);
            if (previous && previous.type !== type) throw failure('Model changed block type', 'MODEL_PROTOCOL_ERROR');
            // Like the host BlockAssembler, first close wins; never append stragglers.
            if (previous?.closed) continue;
            const text = completed ? chunk.block.text : (previous?.text ?? '') + chunk.text;
            const bytes = Buffer.byteLength(text);
            // A shorter final snapshot must not refund previously consumed output budget.
            const chargedBytes = Math.max(previous?.chargedBytes ?? 0, bytes);
            size += chargedBytes - (previous?.chargedBytes ?? 0);
            blocks.set(key, { type, text, chargedBytes, closed: completed });
            output = [...blocks.values()].filter(block => block.type === 'text').map(block => block.text).join('');
            if (size > maxOutputBytes) throw failure('Model output limit exceeded', 'MODEL_OUTPUT_LIMIT');
          }
          if (chunk.type === 'finish') {
            finishKind = chunk.reason.kind;
            if (finishKind !== 'stop' && !(tools.length && finishKind === 'tool-calls')) {
              const error = failure('Model did not complete: ' + finishKind, 'MODEL_INCOMPLETE_OUTPUT');
              Object.assign(error.diagnostic, providerDiagnostic(chunk.reason));
              throw error;
            }
            finished = true;
          }
        }
      } catch (error) {
        // Keep thrown provider/cancellation identity, including frozen and primitive values.
        // Only add safe structured metadata when the error permits it.
        if (error && (typeof error === 'object' || typeof error === 'function') && !failureMetadata.has(error)) {
          const safeDiagnostic = { ...diagnostic(), ...providerDiagnostic(error) };
          failureMetadata.set(error, { code: safeDiagnostic.providerCode, diagnostic: safeDiagnostic });
          try {
            if (Object.isExtensible(error) && !Object.hasOwn(error, 'diagnostic')) {
              Object.defineProperty(error, 'diagnostic', { value: structuredClone(safeDiagnostic), configurable: true, enumerable: true, writable: true });
            }
          } catch { /* Diagnostic accessors/proxies must not replace the primary failure. */ }
        }
        throw error;
      }
      // Cancellation during iterator cleanup/end must not become an invalid-JSON correction.
      signal?.throwIfAborted();
      if (!finished) throw failure('Model stream ended without finish', 'MODEL_INCOMPLETE_OUTPUT');
      try {
        const calls = [...blocks.values()].filter(b => b.type === 'tool-call');
        if (calls.length && (calls.length !== 1 || calls[0].name !== RESULT_TOOL_NAME || typeof calls[0].id !== 'string' || !calls[0].id || output.trim())) throw failure('Ambiguous native result', 'MODEL_PROTOCOL_ERROR');
        if (!calls.length && finishKind === 'tool-calls') throw failure('Missing native result', 'MODEL_PROTOCOL_ERROR');
        const raw = calls.length ? calls[0].arguments : output;
        const text = modelJson(raw, { allowTrailingProse: !!tools.length && !calls.length });
        if (calls.length && !validateNativeResult(text, input, instructions)) throw failure('Wrong native result stage', 'MODEL_PROTOCOL_ERROR');
        const transportKind = calls.length ? 'native-tool' : text !== raw.trim() && !raw.trim().startsWith('```') ? 'trailing-prose' : tools.length ? 'text-compatible' : undefined;
        status = 'completed';
        return { text, diagnostic: diagnostic(), transportKind };
      } catch (error) {
        error.diagnostic = { ...diagnostic(), ...error.diagnostic };
        if (error.code !== 'MODEL_INVALID_JSON') throw error;
        failureCode = 'MODEL_INVALID_JSON';
        issue = jsonIssue(error.diagnostic);
        invalidJsonErrors.add(error);
        failureMetadata.set(error, { code: error.code, diagnostic: error.diagnostic });
        throw error;
      }
    } finally {
      let artifactError;
      if (onModelArtifact) {
        try {
          const captured = []; let remaining = 1024 * 1024 - 4096, truncated = false;
          for (const block of blocks.values()) {
            if (!['text', 'tool-call'].includes(block.type)) continue;
            const field = block.type === 'text' ? 'text' : 'arguments';
            const raw = block[field] ?? '', encoded = Buffer.from(raw);
            let content = raw;
            // JSON string escapes may need six bytes per input byte. Reserve that
            // pessimistic size, trim only at a valid UTF-8 boundary, never repair.
            const cap = Math.max(0, Math.floor((remaining - 2048) / 6));
            if (encoded.length > cap) {
              let end = cap;
              while (end > 0) { try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(encoded.subarray(0, end)); break; } catch { end--; } }
              if (!end) content = '';
              truncated = true;
            }
            const item = block.type === 'text' ? { type: 'text', text: content } : { type: 'tool-call', id: String(block.id ?? '').slice(0, 200), name: String(block.name ?? '').slice(0, 100), arguments: content };
            remaining = Math.max(0, remaining - Buffer.byteLength(JSON.stringify(item)) - 1);
            captured.push(item);
            if (remaining < 4096 || truncated) { truncated = true; break; }
          }
          const raw = JSON.stringify(captured);
          await onModelArtifact({ id: randomUUID(), format: 'dsh-model-output-v1', attempt,
            ...(purposes.has(reviewPhase) ? { phase: reviewPhase } : {}), ...(purpose ? { callPurpose: purpose } : {}),
            status: signal?.aborted ? 'cancelled' : status, bytes: Buffer.byteLength(raw), sha256: createHash('sha256').update(raw).digest('hex'),
            blocks: captured, truncated, untrusted: true });
        } catch {
          status = 'failed'; failureCode = 'MODEL_ARTIFACT_FAILED';
          artifactError = Object.assign(new Error('Private model artifact persistence failed'), { code: 'MODEL_ARTIFACT_FAILED' });
        }
      }
      await notify(onModelEvent, {
        ...event, action: 'model-end', status: signal?.aborted ? 'cancelled' : status,
        ...(failureCode ? { failureCode } : {}), ...(issue ? { jsonIssue: issue } : {}),
        durationMs: Math.max(0, performance.now() - startedAt), firstChunkMs,
        visibleBytes: Buffer.byteLength(output), totalOutputBytes: size,
      });
      if (artifactError) { signal?.throwIfAborted(); throw artifactError; }
    }
  }

  return async function invoke(request) {
    // Snapshot these before an async budget/progress hook can mutate the request.
    const original = { instructions: request.instructions, input: request.input, signal: request.signal, onModelEvent: request.onModelEvent, onModelArtifact: request.onModelArtifact, reviewPhase: request.reviewPhase, callPurpose: request.callPurpose, maxInputBytes: request.maxInputBytes };
    const onProtocolCorrection = request.onProtocolCorrection, onProtocolEvent = request.onProtocolEvent;
    const native = request.nativeOutputTools ?? useNativeTools;
    if (typeof native !== 'boolean') throw new Error('nativeOutputTools must be boolean');
    const tools = native ? modelResultTools(original.input, original.instructions) : [];
    const contract = modelContract(original.input, original.instructions) + (tools.length ? NATIVE_RESULT_INSTRUCTIONS : '');
    const correctionLimit = correctJson ? maxJsonCorrections : 0;
    const attempts = [];
    const prepared = attempt => ({ ...original, attempt, instructions: original.instructions +
      (attempt > 1 ? JSON_CORRECTION_SUFFIX + jsonCorrectionHint(attempts.at(-1)?.diagnostic) + ' 纠正次数：' + (attempt - 1) + '/' + correctionLimit + '。' : '') });
    for (let attempt = 1; ; attempt++) {
      original.signal?.throwIfAborted();
      const next = prepared(attempt);
      checkInputBudget(next, contract, tools);
      let result;
      try {
        result = await once(next, contract, tools);
        original.signal?.throwIfAborted();
      } catch (error) {
        const metadata = failureMetadata.get(error) ?? {};
        failureMetadata.delete(error);
        attempts.push({ attempt, ...structuredClone(metadata) });
        const invalidJson = invalidJsonErrors.delete(error);
        if (!invalidJson || attempt > correctionLimit) {
          try {
            if (attempts.length > 1 && error && typeof error === 'object' && Object.isExtensible(error)) {
              Object.defineProperty(error, 'attempts', { value: structuredClone(attempts), configurable: true, enumerable: true, writable: true });
              if (invalidJson) {
                error.message = 'Model response is not complete JSON after ' + (attempt - 1) +
                  ' explicit JSON correction(s) (' + attempt + ' model calls); correction budget exhausted; no malformed output accepted';
              }
            }
          } catch { /* Preserve provider identity even with hostile accessors/proxies. */ }
          throw error;
        }
        original.signal?.throwIfAborted();
        // Do not reserve or announce a correction that cannot fit the wire budget.
        checkInputBudget(prepared(attempt + 1), contract, tools);
        // Exactly one reservation per extra call; a thrown budget/cancellation veto is final.
        await onProtocolCorrection?.({
          ...structuredClone(metadata), attempts: structuredClone(attempts),
          action: 'explicit-json-correction', type: 'json-syntax', code: 'MODEL_INVALID_JSON',
          ...(jsonIssue(metadata.diagnostic) ? { jsonIssue: jsonIssue(metadata.diagnostic) } : {}), attempt: attempt + 1,
          correction: attempt, maxJsonCorrections: correctionLimit,
          notice: 'Additional model response requested; original output not repaired or accepted.',
        });
        original.signal?.throwIfAborted();
        continue;
      }
      if (attempt > 1) {
        // Out-of-band audit only: never inject metadata into stage-specific model schemas.
        await onProtocolEvent?.({
          action: 'json-correction-complete', attempt, corrections: attempt - 1,
          attempts: structuredClone([...attempts, { attempt, diagnostic: result.diagnostic }]),
          notice: 'Fresh complete JSON accepted; malformed outputs discarded; extra model calls occurred.',
        });
        original.signal?.throwIfAborted();
      }
      if (result.transportKind) await notify(onProtocolEvent, { action: 'json-transport-recovery', kind: result.transportKind, attempt });
      return result.text;
    }
  };
}
