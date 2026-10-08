const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => keys.includes(k));

// Validate the entire batch before exercising any snapshot capability.
export function parseRetrievalResponse(response) {
  const serialized = typeof response === 'string' ? response : JSON.stringify(response);
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > 128 * 1024) throw new Error('Invalid retrieval response size');
  const value = JSON.parse(serialized);
  if (!exact(value, ['requests']) || !Array.isArray(value.requests) || value.requests.length < 1 || value.requests.length > 8) throw new Error('Invalid retrieval batch');
  for (const request of value.requests) {
    if (request?.kind === 'read') {
      if (!exact(request, ['kind', 'id', 'start', 'count']) || typeof request.id !== 'string' || !request.id || request.id.length > 200 || !Number.isSafeInteger(request.start) || request.start < 1 || !Number.isSafeInteger(request.count) || request.count < 1 || request.count > 200) throw new Error('Invalid read request');
    } else if (request?.kind === 'search') {
      if (!exact(request, ['kind', 'query', 'limit', 'sourceIds']) || typeof request.query !== 'string' || !request.query || request.query.length > 256 || /[\r\n]/.test(request.query) || !Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) throw new Error('Invalid search request');
      if (request.sourceIds !== undefined && (!Array.isArray(request.sourceIds) || request.sourceIds.length < 1 || request.sourceIds.length > 20 || new Set(request.sourceIds).size !== request.sourceIds.length || request.sourceIds.some(id => typeof id !== 'string' || !id || id.length > 200))) throw new Error('Invalid search source filter');
    } else throw new Error('Unsupported retrieval operation');
  }
  return value.requests;
}

export function executeRetrievalBatch(response, scope, signal, onResult = () => {}) {
  signal?.throwIfAborted();
  const requests = parseRetrievalResponse(response);
  const allowed = new Set(scope.catalog().map(item => item.id));
  if (requests.some(r => r.kind === 'read' ? !allowed.has(r.id) : r.sourceIds?.some(id=>!allowed.has(id)))) throw new Error('Source not authorized');
  return requests.map(request => {
    signal?.throwIfAborted();
    const item = { request, result: request.kind === 'read' ? scope.read(request) : scope.search(request) };
    onResult(item);
    return item;
  });
}
