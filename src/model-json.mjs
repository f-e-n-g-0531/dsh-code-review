// Accept one complete JSON value, optionally inside one exact Markdown fence.
export function modelJson(text) {
 const bytes=Buffer.byteLength(text);
 const trimmed=text.trim();
 const fence=/^```(?:json)?\r?\n([\s\S]*)\r?\n```$/.exec(trimmed);
 const body=fence?fence[1]:trimmed;
 try { JSON.parse(body); } catch {
  const shape = !trimmed ? 'empty' : trimmed.startsWith('```') && !fence ? 'non-exact-fence' : /^[{\[]/.test(body) ? 'json-like-invalid' : 'non-json-leading';
  const error=new Error('Model response is not complete JSON (bytes='+bytes+', envelope='+(fence?'json-fence':'plain')+', shape='+shape+'); no repair or retry performed');
  error.code='MODEL_INVALID_JSON';throw error;
 }
 return body;
}
