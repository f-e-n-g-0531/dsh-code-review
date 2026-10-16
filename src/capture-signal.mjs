// Capture follows the host/user cancellation lifetime. No plugin stopwatch.
export function captureSignal(signal){return signal??new AbortController().signal;}
