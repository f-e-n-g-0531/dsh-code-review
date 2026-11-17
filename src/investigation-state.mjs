import { createHash, randomUUID } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');
const fail = () => { throw new Error('Investigation evidence identity mismatch'); };
export const INVESTIGATION_NOTICE = 'Untrusted investigation navigation only, not evidence, coverage, verification or a receipt. Compressed bodies require a fresh approved read for exact evidence; spent root budget is not refunded. Unresolved dependencies remain unresolved.';

// Invocation-local only. No model output, source body cache, global state or authority.
export function createInvestigationState(catalog, snapshotId) {
  const sources = new Map(catalog.map(source => [source.id, structuredClone(source)]));
  const hashes = new Map(), compacted = new WeakSet();
  const chainId = randomUUID();
  let snapshot = snapshotId;
  const identity = value => {
    if (typeof value !== 'string' || !value) fail();
    if (snapshot === undefined) snapshot = value;
    if (snapshot !== value) fail();
  };
  function sourceIdentity(id, hash, side) {
    const source = sources.get(id);
    if (!source || typeof hash !== 'string' || !hash || (source.hash !== undefined && source.hash !== hash) || (side !== undefined && side !== source.side) || (hashes.has(id) && hashes.get(id) !== hash)) fail();
    hashes.set(id, hash);
    return source;
  }
  function navigation(item) {
    const { request, result } = item;
    identity(result.snapshotId);
    if (request.kind === 'read') {
      const source = sourceIdentity(result.sourceId, result.hash, result.side);
      if (request.id !== result.sourceId || request.start !== result.start || !Number.isSafeInteger(result.count) || result.count < 1 || result.count > request.count || result.start + result.count - 1 > source.lineCount) fail();
      return { kind: 'read', snapshotId: snapshot, sourceId: result.sourceId, side: source.side, hash: result.hash, start: result.start, count: result.count, bodyHash: typeof result.text === 'string' ? digest(result.text) : result.bodyHash };
    }
    if (!['find', 'search'].includes(request.kind) || !Array.isArray(result.matches)) fail();
    return { kind: request.kind, snapshotId: snapshot, query: request.query, sourceIds: request.sourceIds, truncated: result.truncated === true,
      matches: result.matches.map(match => { const source = sourceIdentity(match.sourceId, match.hash, match.side); return { sourceId: match.sourceId, side: source.side, hash: match.hash, ...(match.line !== undefined ? { line: match.line } : {}) }; }) };
  }
  return Object.freeze({
    describe(records) { return { version: 1, chainId, trust: 'navigation-only', notice: INVESTIGATION_NOTICE, checked: records.map(item => compacted.has(item) ? item.navigation : navigation(item)), unresolved: 'No completion inferred from prior reads or searches; continue pending requests under the original budget.' }; },
    compact(item) {
      if (compacted.has(item)) return item;
      const nav = navigation(item);
      const compact = { request: structuredClone(item.request), result: { omitted: true, reason: 'compressed-navigation-only' }, navigation: nav };
      compacted.add(compact); return compact;
    },
    validate(records) { for (const item of records) if (!compacted.has(item) && !item.result.omitted) navigation(item); },
  });
}

// Only rewrite exact host deliveries already observed by this activation. Never
// parse arbitrary assistant/user text as trusted state, or alter tools/system.
export function createChildInvestigationCompactor(state, ownerSessionId) {
  const deliveries = new Map();
  let latest;
  const pending = new Map(), calls = new Map(), completed = new Set();
  return Object.freeze({
    delivered(delivery) {
      state.validate(delivery.results);
      const compact = { ...delivery, results: [], investigationState: state.describe(delivery.results) };
      const json = JSON.stringify(delivery), key = digest(json);
      deliveries.set(key, JSON.stringify(compact)); latest = key;
    },
    observeEvent(event, sessionId) {
      if (ownerSessionId !== undefined && sessionId !== ownerSessionId) return;
      if (event.type === 'tool/call') {
        const { callId, name, turn, step } = event.data ?? {};
        if (typeof callId !== 'string') return;
        if (calls.has(callId)) throw new Error('Duplicate investigation tool call identity');
        calls.set(callId, { name, turn, step, seq: event.seq }); return;
      }
      // Only successful original tool-result commits from the owning session.
      if (event.type !== 'tool/result' || event.surfaceOp !== 'append' || event.data?.message?.role !== 'tool' || event.data.message.isError || !Number.isSafeInteger(event.seq)) return;
      const message = event.data.message;
      if (typeof message.toolCallId !== 'string' || !Array.isArray(message.content)) return;
      const call = calls.get(message.toolCallId);
      if (!call || call.name !== 'review_snapshot' || completed.has(message.toolCallId) || call.turn !== event.data.turn || call.step !== event.data.step || !event.sourceEventSeqs?.includes(call.seq) || message.source?.callId !== message.toolCallId) return;
      completed.add(message.toolCallId);
      let key;
      const keys = [];
      const content = message.content.map(block => {
        if (block?.type !== 'text' || typeof block.text !== 'string') return block;
        const hash = digest(block.text), replacement = deliveries.get(hash);
        if (!replacement || Buffer.byteLength(replacement) >= Buffer.byteLength(block.text)) return block;
        key = hash; keys.push(hash); return { ...block, text: replacement };
      });
      if (!key) return;
      // The event data is copied with only the content replaced. No original
      // source body or assistant/private response is retained by this helper.
      pending.set(event.seq, { keys, data: { ...event.data, message: { ...message, content } } });
    },
    replaceSurface(session, signal) {
      signal?.throwIfAborted();
      let replaced = 0;
      for (const [seq, item] of pending) {
        if (item.keys.includes(latest)) continue;
        signal?.throwIfAborted();
        session.append('tool/result', item.data, { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] });
        pending.delete(seq); replaced++;
      }
      return replaced;
    },
    compact(options) {
      let changed = false;
      const calls = new Map();
      for (const message of options.messages ?? []) {
        if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
        for (const block of message.content) if (block?.type === 'tool-call' && typeof block.id === 'string') {
          calls.set(block.id, calls.has(block.id) ? null : block.name);
        }
      }
      const messages = options.messages?.map(message => {
        // This recognized logical tool message shape preserves call/result pairing.
        // Other native/provider shapes are deliberately left untouched.
        if (message.role !== 'tool' || (message.name !== 'review_snapshot' && calls.get(message.toolCallId) !== 'review_snapshot') || typeof message.toolCallId !== 'string' || !Array.isArray(message.content)) return message;
        const content = message.content.map(block => {
          if (block?.type !== 'text' || typeof block.text !== 'string') return block;
          const key = digest(block.text), replacement = deliveries.get(key);
          if (key === latest || !replacement || Buffer.byteLength(replacement) >= Buffer.byteLength(block.text)) return block;
          changed = true; return { ...block, text: replacement };
        });
        return { ...message, content };
      });
      // The installed DSH freezes stream options and waterfall next() accepts no
      // replacement arguments. Do not mutate nested shared session history to
      // bypass that contract. A future writable request projection may opt in.
      const descriptor = Object.getOwnPropertyDescriptor(options, 'messages');
      if (changed && descriptor?.writable === true) { options.messages = messages; return true; }
      return false;
    },
  });
}
