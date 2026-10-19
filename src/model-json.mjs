// Accept one complete JSON value, optionally inside one exact Markdown fence.
// This parser never repairs bytes or invokes a model; orchestration owns corrections.
export function modelJson(text) {
  const bytes = Buffer.byteLength(text);
  const trimmed = text.trim();
  const fence = /^```(?:json)?\r?\n([\s\S]*)\r?\n```$/.exec(trimmed);
  const body = fence ? fence[1] : trimmed;
  try {
    JSON.parse(body);
  } catch {
    const envelope = fence ? 'json-fence' : 'plain';
    const shape = !trimmed ? 'empty' : trimmed.startsWith('```') && !fence ? 'non-exact-fence' : /^[{\[]/.test(body) ? 'json-like-invalid' : 'non-json-leading';
    const error = new Error('Model response is not complete JSON (bytes=' + bytes + ', envelope=' + envelope + ', shape=' + shape + '); no repair or retry performed by JSON parser');
    error.code = 'MODEL_INVALID_JSON';
    error.diagnostic = { jsonBytes: bytes, envelope, shape };
    throw error;
  }
  return body;
}
