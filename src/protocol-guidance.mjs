// Original, bounded review hints; no parser, I/O, schema enforcement or defect proof.
const checks={
 protobuf:[
  'Check numeric tag/enum value reuse and removed field reservations against persisted messages and actual consumers; additive fields alone are not defects.',
  'Check oneof, presence, defaults and type changes for the deployed syntax/edition/runtime; distinguish binary wire compatibility from JSON names and generated API compatibility.'
 ],
 thrift:[
  'Check field IDs/types, requiredness and defaults against the actual protocol and old/new consumers; declaration order is not identity and Thrift has no reserved keyword.',
  'Check method names, oneway/reply semantics, exceptions and include/namespace bindings against generated clients; additive optional fields alone do not prove breakage.'
 ],
 capnp:[
  'Check ordinals, explicit type IDs, fixed-width storage and default XOR encoding against existing data and deployed readers; do not infer identity from declaration order.',
  'Check union/layout evolution and generated API consumers separately from wire compatibility; same-ordinal rename alone usually does not break wire data.'
 ],
 graphql:[
  'Check input non-null/default changes, removed fields/arguments and operation compatibility using actual clients; GraphQL has no numeric field tags.',
  'Check output null bubbling, enum consumers and resolver authorization using captured implementation; absent auth directives or additive fields/enum values alone do not prove a defect.'
 ],
 prisma:[
  'Check provider, relationMode, relation actions, constraints and nullability against the deployed database, migration and generated-client consumers; schema is not an applied migration.',
  'Check concrete data loss, migration order and client rollout counterexamples; do not require indexes or tenant fields from names alone or invent database enforcement in emulated relations.'
 ]
};
export function protocolGuidance(filePath){const lower=filePath.toLowerCase();const language=/.proto$/.test(lower)?'protobuf':/.thrift$/.test(lower)?'thrift':/.capnp$/.test(lower)?'capnp':/.(graphql|gql)$/.test(lower)?'graphql':/.prisma$/.test(lower)?'prisma':undefined;return language?{language,checks:[...checks[language]]}:undefined;}
