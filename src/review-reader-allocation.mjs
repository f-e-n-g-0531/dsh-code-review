// Per-stage admission over ONE approved root ledger, not independent readers.
// Fixed proportional floors protect future stages; released unused floors become
// shared capacity. No content/source identifiers are emitted by summary().
export function createReviewReaderAllocation(root, units) {
  if (!root || !['budget', 'usage', 'preflight', 'transaction', 'read', 'find', 'search', 'catalog'].every(key => typeof root[key] === 'function')) throw new Error('Invalid root reader allocation');
  if (!Array.isArray(units) || units.length > 2000) throw new Error('Invalid reader allocation units');
  const budget = root.budget();
  if (![budget.remainingCalls, budget.remainingOutputBytes].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('Invalid root reader allocation budget');
  const states = new Map(); let totalWeight = 0;
  for (const unit of units) {
    if (!unit || typeof unit.id !== 'string' || !unit.id || unit.id.length > 500 || states.has(unit.id) || !Number.isSafeInteger(unit.weight) || unit.weight < 1 || unit.weight > 1000000) throw new Error('Invalid reader allocation unit');
    states.set(unit.id, { weight: unit.weight, calls: 0, outputBytes: 0, cacheHits: 0, released: false, inTransaction: false });
    totalWeight += unit.weight;
  }
  for (const state of states.values()) {
    state.callFloor = Math.floor(budget.remainingCalls * state.weight / totalWeight);
    state.byteFloor = Math.floor(budget.remainingOutputBytes * state.weight / totalWeight);
  }
  const fail = kind => { const error = new Error('Reader allocation ' + kind + ' budget exceeded'); error.code = kind === 'call' ? 'READER_CALL_BUDGET_EXCEEDED' : 'READER_OUTPUT_BUDGET_EXCEEDED'; throw error; };
  const live = id => { const state = states.get(id); if (!state || state.released) throw new Error('Reader allocation unit unavailable'); return state; };
  const available = state => {
    const remaining = root.budget(); let protectedCalls = 0, protectedBytes = 0;
    for (const other of states.values()) {
      if (other === state || other.released) continue;
      protectedCalls += Math.max(0, other.callFloor - other.calls);
      protectedBytes += Math.max(0, other.byteFloor - other.outputBytes);
    }
    return { ...remaining, remainingCalls: Math.max(0, remaining.remainingCalls - protectedCalls), remainingOutputBytes: Math.max(0, remaining.remainingOutputBytes - protectedBytes) };
  };
  const check = (state, cost) => { const remaining = available(state); if (cost.calls > remaining.remainingCalls) fail('call'); if (cost.outputBytes > remaining.remainingOutputBytes) fail('output'); };
  const scopes = new Map();
  return Object.freeze({
    scope(id) {
      const state = live(id); if (scopes.has(id)) return scopes.get(id);
      const preflight = requests => { live(id); const cost = root.preflight(requests); if (!cost || !Number.isSafeInteger(cost.calls) || !Number.isSafeInteger(cost.outputBytes)) throw new Error('Reader allocation preflight unavailable'); check(state, cost); return cost; };
      const execute = operation => {
        live(id); const before = root.usage(), remaining = available(state);
        const result = operation(), after = root.usage();
        const calls = after.calls - before.calls, outputBytes = after.outputBytes - before.outputBytes;
        if (calls > remaining.remainingCalls) fail('call');
        if (outputBytes > remaining.remainingOutputBytes) fail('output');
        state.calls += calls; state.outputBytes += outputBytes; state.cacheHits += (after.cacheHits ?? 0) - (before.cacheHits ?? 0);
        return result;
      };
      const operation = (kind, request, decorate) => {
        preflight([{ ...request, kind }]);
        const run = () => execute(() => kind === 'read' ? root.read(request, decorate) : root[kind](request));
        if (state.inTransaction) return run();
        const before = { calls: state.calls, outputBytes: state.outputBytes, cacheHits: state.cacheHits };
        try { return root.transaction(run); } catch (error) { Object.assign(state, before); throw error; }
      };
      const scope = Object.freeze({
        catalog: () => { live(id); return root.catalog(); },
        budget: () => { live(id); return available(state); },
        usage: () => ({ calls: state.calls, outputBytes: state.outputBytes, cacheHits: state.cacheHits }),
        preflight,
        canServe(requests) { try { preflight(requests); return true; } catch { return false; } },
        read: (request, decorate) => operation('read', request, decorate),
        find: request => operation('find', request),
        search: request => operation('search', request),
        transaction(executeBatch) {
          live(id); if (state.inTransaction || typeof executeBatch !== 'function') throw new Error('Invalid reader allocation transaction');
          const before = { calls: state.calls, outputBytes: state.outputBytes, cacheHits: state.cacheHits };
          state.inTransaction = true;
          try { return root.transaction(executeBatch); }
          catch (error) { Object.assign(state, before); throw error; }
          finally { state.inTransaction = false; }
        },
      });
      scopes.set(id, scope); return scope;
    },
    release(id) { const state = states.get(id); if (!state) return; if (state.inTransaction) throw new Error('Reader allocation transaction active'); state.released = true; },
    summary() { const usage = root.usage(); return { units: states.size, releasedUnits: [...states.values()].filter(state => state.released).length, calls: usage.calls, outputBytes: usage.outputBytes, ...(usage.cacheHits !== undefined ? { cacheHits: usage.cacheHits } : {}) }; },
  });
}
