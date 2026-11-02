import { prepareStageGenerations } from './review-stage-state.mjs';

// Only host-validated generations enter this cache. Failed admission leaves the
// last good set unchanged; imported checkpoints still fail closed in the validator.
export function createStageGenerationCache(snapshot, records = [], { maxBytes = 8 * 1024 * 1024 } = {}) {
  let saved = prepareStageGenerations(snapshot, records, { maxBytes });
  return {
    records() { return structuredClone(saved); },
    admit(record) {
      let normalized;
      try { [normalized] = prepareStageGenerations(snapshot, [record]); }
      catch { return { accepted: false, code: 'STAGE_CACHE_RECORD_REJECTED' }; }
      const next = saved.filter(row => row.key !== normalized.key);
      next.push(normalized);
      let checked;
      try { checked = prepareStageGenerations(snapshot, next, { maxBytes }); }
      catch { return { accepted: false, code: 'STAGE_CACHE_CAPACITY_EXCEEDED' }; }
      saved = checked;
      return { accepted: true, record: structuredClone(normalized) };
    },
  };
}
