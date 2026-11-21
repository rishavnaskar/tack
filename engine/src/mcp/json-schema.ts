/**
 * The slice of JSON Schema that tool inputs use, and a validator for it.
 *
 * Tool arguments come from a model. A wrong type is refused with the path
 * that failed, so the model can correct the call instead of guessing.
 */
export type JsonSchema =
  | { type: 'string'; description?: string; enum?: readonly string[]; minLength?: number; maxLength?: number }
  | { type: 'number' | 'integer'; description?: string; minimum?: number; maximum?: number }
  | { type: 'boolean'; description?: string }
  | { type: 'array'; description?: string; items: JsonSchema; minItems?: number; maxItems?: number }
  | ObjectSchema;

export interface ObjectSchema {
  type: 'object';
  description?: string;
  properties: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean;
}

/** Returns what is wrong, or null when the value fits. */
export function validate(schema: JsonSchema, value: unknown, path = 'arguments'): string | null {
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') return `${path} must be a string`;
      if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of: ${schema.enum.join(', ')}`;
      if (schema.minLength !== undefined && value.length < schema.minLength) return `${path} is too short`;
      if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${path} is longer than ${schema.maxLength} characters`;
      return null;
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${path} must be a number`;
      if (schema.type === 'integer' && !Number.isInteger(value)) return `${path} must be a whole number`;
      if (schema.minimum !== undefined && value < schema.minimum) return `${path} must be at least ${schema.minimum}`;
      if (schema.maximum !== undefined && value > schema.maximum) return `${path} must be at most ${schema.maximum}`;
      return null;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${path} must be true or false`;
    case 'array': {
      if (!Array.isArray(value)) return `${path} must be a list`;
      if (schema.minItems !== undefined && value.length < schema.minItems) return `${path} needs at least ${schema.minItems} item(s)`;
      if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path} takes at most ${schema.maxItems} items`;
      for (const [i, item] of value.entries()) {
        const problem = validate(schema.items, item, `${path}[${i}]`);
        if (problem) return problem;
      }
      return null;
    }
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${path} must be an object`;
      const record = value as Record<string, unknown>;
      for (const name of schema.required ?? []) {
        // null is no value either: a required field left null was not given.
        if (record[name] === undefined || record[name] === null) return `${path}.${name} is required`;
      }
      for (const [name, v] of Object.entries(record)) {
        const property = schema.properties[name];
        if (!property) {
          if (schema.additionalProperties === false) return `${path}.${name} is not a known field`;
          continue;
        }
        if (v === undefined || v === null) continue;
        const problem = validate(property, v, `${path}.${name}`);
        if (problem) return problem;
      }
      return null;
    }
  }
}
