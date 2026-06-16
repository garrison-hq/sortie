/**
 * JSON Schema -> zod conversion for the common subset used by CLI/server
 * inputs, where callers provide a JSON Schema document instead of a zod
 * schema.
 *
 * Supported: object (properties/required), array (items), string (enum),
 * number, integer, boolean, null, nullable type arrays (['string','null']),
 * and description passthrough. Anything unsupported degrades to z.unknown()
 * rather than throwing.
 */
import { z } from 'zod';

/** Convert a JSON Schema object to an equivalent zod schema. */
export function jsonSchemaToZod(js: Record<string, unknown>): z.ZodType {
  return convertNode(js);
}

function convertNode(node: unknown): z.ZodType {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    return z.unknown();
  }
  const js = node as Record<string, unknown>;
  let schema = convertByType(js);
  if (typeof js['description'] === 'string') {
    schema = schema.describe(js['description']);
  }
  return schema;
}

function convertByType(js: Record<string, unknown>): z.ZodType {
  const type = js['type'];

  if (typeof type === 'string') {
    return convertSingleType(js, type);
  }

  if (Array.isArray(type)) {
    const nonNull = type.filter((t): t is string => typeof t === 'string' && t !== 'null');
    const nullable = type.includes('null');

    if (nonNull.length === 0) {
      return nullable ? z.null() : z.unknown();
    }

    let schema: z.ZodType;
    if (nonNull.length === 1) {
      schema = convertSingleType(js, nonNull[0] as string);
    } else {
      const variants = nonNull.map((t) => convertSingleType(js, t));
      schema = z.union(variants);
    }
    return nullable ? schema.nullable() : schema;
  }

  // No "type" keyword: support a bare string enum, otherwise unknown.
  if (Array.isArray(js['enum'])) {
    return convertEnum(js['enum']) ?? z.unknown();
  }
  return z.unknown();
}

function convertSingleType(js: Record<string, unknown>, type: string): z.ZodType {
  switch (type) {
    case 'object':
      return convertObject(js);
    case 'array':
      return z.array(js['items'] === undefined ? z.unknown() : convertNode(js['items']));
    case 'string': {
      if (Array.isArray(js['enum'])) {
        const asEnum = convertEnum(js['enum']);
        if (asEnum) return asEnum;
      }
      return z.string();
    }
    case 'number':
      return z.number();
    case 'integer':
      return z.number().int();
    case 'boolean':
      return z.boolean();
    case 'null':
      return z.null();
    default:
      return z.unknown();
  }
}

function convertObject(js: Record<string, unknown>): z.ZodType {
  const rawProps = js['properties'];
  if (
    rawProps === undefined ||
    rawProps === null ||
    typeof rawProps !== 'object' ||
    Array.isArray(rawProps)
  ) {
    // Object with no declared properties: accept any string-keyed record.
    return z.record(z.string(), z.unknown());
  }

  const required = new Set(
    Array.isArray(js['required'])
      ? js['required'].filter((r): r is string => typeof r === 'string')
      : [],
  );

  const shape: Record<string, z.ZodType> = {};
  for (const [key, value] of Object.entries(rawProps as Record<string, unknown>)) {
    const propSchema = convertNode(value);
    shape[key] = required.has(key) ? propSchema : propSchema.optional();
  }
  return z.object(shape);
}

function convertEnum(values: unknown[]): z.ZodType | null {
  const strings = values.filter((v): v is string => typeof v === 'string');
  if (strings.length === 0 || strings.length !== values.length) return null;
  return z.enum(strings as [string, ...string[]]);
}
