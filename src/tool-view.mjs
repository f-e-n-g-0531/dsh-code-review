// Shared tool output schema + renderer for the JSON+Markdown review tools.
export const reviewToolOutput = {
  schema: { type: 'object', additionalProperties: false, properties: { json: { type: 'string' }, markdown: { type: 'string' } }, required: ['json', 'markdown'] },
  render: (_args, value) => [{ type: 'text', text: value.markdown || value.json }],
};
