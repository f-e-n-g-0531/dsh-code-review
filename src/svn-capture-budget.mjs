import { captureSignal } from './capture-signal.mjs';

// Shared across initial capture, navigation, mergeinfo and final verification.
export function createSvnCaptureBudget(signal) {
  const deadline = captureSignal(signal);
  let commands = 0, metadataBytes = 0, bodyBytes = 0;
  const budgetError = message => Object.assign(new Error(message), { code: 'SVN_CAPTURE_BUDGET' });
  return Object.freeze({
    signal: deadline,
    reserve() { deadline.throwIfAborted(); commands++; },
    charge(size, body = false) {
      deadline.throwIfAborted();
      if (!Number.isSafeInteger(size) || size < 0) throw budgetError('Invalid SVN capture byte charge');
      if (body) {
        bodyBytes += size;
        if (bodyBytes > 16 * 1024 * 1024) throw budgetError('SVN capture shared verification body budget exceeded');
      } else {
        metadataBytes += size;
        if (metadataBytes > 1024 * 1024) throw budgetError('SVN capture shared metadata budget exceeded');
      }
    },
    usage() { return { commands, metadataBytes, bodyBytes }; },
  });
}
