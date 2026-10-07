type SchemaNode = Record<string, any>;

export function validateAgainstJsonSchema(value: unknown, schema: SchemaNode, path = '$'): string[] {
  if (schema.anyOf) {
    const variants = schema.anyOf as SchemaNode[];
    if (variants.some((variant) => validateAgainstJsonSchema(value, variant, path).length === 0)) return [];
    return [`${path}: no allowed schema variant matched`];
  }
  const types: string[] = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const matches = (type: string): boolean => {
    if (type === 'null') return value === null;
    if (type === 'object') return Boolean(value && typeof value === 'object' && !Array.isArray(value));
    if (type === 'array') return Array.isArray(value);
    if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (type === 'string') return typeof value === 'string';
    if (type === 'boolean') return typeof value === 'boolean';
    return true;
  };
  if (types.length && !types.some(matches)) return [`${path}: expected ${types.join('|')}`];
  const errors: string[] = [];
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: unsupported value`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: too long`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum`);
  }
  if (Array.isArray(value) && schema.items) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: too many items`);
    value.forEach((item, index) => errors.push(...validateAgainstJsonSchema(item, schema.items, `${path}[${index}]`)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in object)) errors.push(`${path}.${key}: required`);
    for (const key of Object.keys(object)) {
      const property = schema.properties?.[key];
      if (!property) {
        if (schema.additionalProperties === false) errors.push(`${path}.${key}: unexpected property`);
      } else errors.push(...validateAgainstJsonSchema(object[key], property, `${path}.${key}`));
    }
  }
  return errors;
}
