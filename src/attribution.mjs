import { changeMap } from './change-map.mjs';

// Reference validity is not proof of the model's causal explanation.
export function validateAttribution(value, file, changes = changeMap(file.left.text, file.right.text)) {
  if (value === undefined) return { status: 'missing', causality: 'unverified' };
  if (!value || typeof value !== 'object' || !Array.isArray(value.editIds) || !Array.isArray(value.properties)) throw new Error('Invalid attribution');
  if (value.editIds.length > 50 || value.properties.length > 50) throw new Error('Too many attribution references');
  const text = s => typeof s === 'string' && s.trim().length > 0 && s.length <= 8000;
  if (!text(value.beforeBehavior) || !text(value.afterBehavior) || !text(value.reason)) throw new Error('Missing attribution explanation');
  const ids = new Set(changes.edits.map(e => e.id));
  const properties = new Set(file.properties.filter(p => p.old !== p.new).map(p => p.name));
  if (value.editIds.some(id => typeof id !== 'string' || !ids.has(id)) || value.properties.some(name => typeof name !== 'string' || !properties.has(name))) throw new Error('Unknown change reference');
  if (new Set(value.editIds).size !== value.editIds.length || new Set(value.properties).size !== value.properties.length) throw new Error('Duplicate change reference');
  if (!value.editIds.length && !value.properties.length) throw new Error('Attribution requires a change reference');
  return { status: 'references-validated', causality: 'unverified', editIds: [...value.editIds], properties: [...value.properties], beforeBehavior: value.beforeBehavior, afterBehavior: value.afterBehavior, reason: value.reason };
}
