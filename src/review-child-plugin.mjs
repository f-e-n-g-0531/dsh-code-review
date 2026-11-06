import { assertReviewChildAgent, executeReviewChildRequests } from './review-child-broker.mjs';

export const name = 'dsh-code-review-restricted-child';
export const inject = ['tools'];

// Shared descriptor: registration and input-budget measurement use the same schema.
export const SNAPSHOT_TOOL_SCHEMA = {
    name: 'review_snapshot',
    description: "Internal tool for registered review children only; ordinary parent/other agents cannot call it. Read only the approved snapshot. Send 1..8 requests using EXACT kind and fields: read(id,start,count), find(query,limit), search(query,limit,sourceIds optional). Use catalog source identities, never paths, as id/sourceIds. read start is a 1-based line integer >=1 and count is integer 1..200. find searches catalog paths by literal substring; search searches captured content by literal substring, NOT regex. query is nonempty, at most 256 characters, single-line; limit is integer 1..100. Optional sourceIds contains 1..20 distinct catalog IDs. No operation/type/path/line aliases. Examples (replace catalog-id with an approved catalog ID): {\"requests\":[{\"kind\":\"read\",\"id\":\"catalog-id\",\"start\":1,\"count\":40}]}; {\"requests\":[{\"kind\":\"find\",\"query\":\"Widget\",\"limit\":10}]}; {\"requests\":[{\"kind\":\"search\",\"query\":\"dispose(\",\"limit\":20,\"sourceIds\":[\"catalog-id\"]}]}. No filesystem, shell, network, or additional agents.",
    parameters: {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "requests": {
          "type": "array",
          "description": "Batch of 1..8 requests. Exact fields only; parser enforces all numeric, query, and catalog authorization limits.",
          "items": {
            "oneOf": [
              {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "kind": {
                    "type": "string",
                    "const": "read"
                  },
                  "id": {
                    "type": "string",
                    "description": "Exact approved catalog source id, nonempty, at most 200 characters; not a file path."
                  },
                  "start": {
                    "type": "integer",
                    "description": "1-based first line; safe integer >=1."
                  },
                  "count": {
                    "type": "integer",
                    "description": "Number of lines; safe integer 1..200."
                  }
                },
                "required": [
                  "kind",
                  "id",
                  "start",
                  "count"
                ]
              },
              {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "kind": {
                    "type": "string",
                    "const": "find"
                  },
                  "query": {
                    "type": "string",
                    "description": "Literal substring of a catalog path; nonempty single-line string, at most 256 characters; not regex."
                  },
                  "limit": {
                    "type": "integer",
                    "description": "Maximum matches; safe integer 1..100."
                  }
                },
                "required": [
                  "kind",
                  "query",
                  "limit"
                ]
              },
              {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "kind": {
                    "type": "string",
                    "const": "search"
                  },
                  "query": {
                    "type": "string",
                    "description": "Literal substring of captured source content; nonempty single-line string, at most 256 characters; not regex."
                  },
                  "limit": {
                    "type": "integer",
                    "description": "Maximum matches; safe integer 1..100."
                  },
                  "sourceIds": {
                    "type": "array",
                    "description": "Optional filter: 1..20 distinct, nonempty approved catalog source IDs, each at most 200 characters.",
                    "items": {
                      "type": "string"
                    }
                  }
                },
                "required": [
                  "kind",
                  "query",
                  "limit"
                ]
              }
            ]
          }
        }
      },
      "required": [
        "requests"
      ]
    },
};

export function registerSnapshotTool(ctx) {
  // Root registration stays dynamic: never capture a particular child binding.
  ctx.tools.register({
    ...SNAPSHOT_TOOL_SCHEMA,
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { json: { type: 'string' } }, required: ['json'] },
      render: (_args, value) => [{ type: 'text', text: value.json }],
    },
    async execute(args, exec) {
      const result = await executeReviewChildRequests(args, exec);
      // Recheck after asynchronous business logic: revoked work cannot leak a result.
      assertReviewChildAgent(exec?.agent?.id, exec?.agent);
      return { json: JSON.stringify(result) };
    },
  });
}
export function apply(ctx) {
  ctx.tools.restrict({ allow: ['review_snapshot'] });
  // Identity only: installation above must precede the host's tool assembly.
  ctx.on('agent/pre-step', ({ agent }, next) => {
    assertReviewChildAgent(agent?.id, agent);
    return next();
  });
}
