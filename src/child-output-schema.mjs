// The host's structured_output accepts a documented finite JSON Schema subset.
// Numeric/length bounds remain mandatory in the ordinary review validators.
const annotations = new Set(['title', 'description', 'default']);
const scalars = new Set(['type', 'enum', 'const', 'required', 'additionalProperties', ...annotations]);
export function childOutputSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('Invalid child output schema');
  const result = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties') result.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, childOutputSchema(child)]));
    else if (key === 'items') result.items = childOutputSchema(value);
    else if (key === 'oneOf') result.oneOf = value.map(childOutputSchema);
    else if (scalars.has(key)) result[key] = structuredClone(value);
    else if (!['minimum','maximum','minItems','maxItems','minLength','maxLength','pattern'].includes(key)) throw new Error('Unknown child schema constraint: ' + key);
  }
  if (!result.type && !result.oneOf) {
    const values = result.enum ?? (Object.hasOwn(result, 'const') ? [result.const] : []);
    const types = [...new Set(values.map(value => value === null ? 'null' : typeof value))];
    if (types.length === 1 && ['string','number','boolean','null'].includes(types[0])) result.type = types[0];
    else if (values.length) throw new Error('Ambiguous child enum type');
  }
  return result;
}
