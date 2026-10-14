const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => keys.includes(k));

function invalidRead(request, index) {
  const fields = [];
  if (!exact(request, ['kind', 'id', 'start', 'count'])) fields.push('fields');
  if (typeof request.id !== 'string' || !request.id || request.id.length > 200) fields.push('id');
  if (!Number.isSafeInteger(request.start) || request.start < 1) fields.push('start');
  if (!Number.isSafeInteger(request.count) || request.count < 1 || request.count > 200) fields.push('count');
  if (fields.length) {
    // Fixed names only: never echo model-supplied paths, IDs, source or values.
    const error = new Error('Invalid read request (index=' + index + ', invalid=' + fields.join(',') + '; id=catalog identity, start=integer>=1, count=integer 1..200)');
    error.code = 'MODEL_INVALID_READ_REQUEST';
    throw error;
  }
}

// Validate the entire batch before exercising any snapshot capability.
export function parseRetrievalResponse(response) {
  const serialized = typeof response === 'string' ? response : JSON.stringify(response);
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > 128 * 1024) throw new Error('Invalid retrieval response size');
  const value = JSON.parse(serialized);
  if (!exact(value, ['requests']) || !Array.isArray(value.requests) || value.requests.length < 1 || value.requests.length > 8) throw new Error('Invalid retrieval batch');
  for (const [index, request] of value.requests.entries()) {
    if (request?.kind === 'read') {
      invalidRead(request, index);
    } else if (request?.kind === 'search') {
      if (!exact(request, ['kind', 'query', 'limit', 'sourceIds']) || typeof request.query !== 'string' || !request.query || request.query.length > 256 || /[\r\n]/.test(request.query) || !Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) throw new Error('Invalid search request');
      if (request.sourceIds !== undefined && (!Array.isArray(request.sourceIds) || request.sourceIds.length < 1 || request.sourceIds.length > 20 || new Set(request.sourceIds).size !== request.sourceIds.length || request.sourceIds.some(id => typeof id !== 'string' || !id || id.length > 200))) throw new Error('Invalid search source filter');
    } else if (request?.kind === 'find') {
      if (!exact(request, ['kind','query','limit']) || typeof request.query !== 'string' || !request.query || request.query.length > 256 || /[\r\n]/.test(request.query) || !Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) throw new Error('Invalid find request');
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
    const item = { request, result: request.kind === 'read' ? scope.read(request) : request.kind === 'find' ? scope.find(request) : scope.search(request) };
    onResult(item);
    return item;
  });
}
