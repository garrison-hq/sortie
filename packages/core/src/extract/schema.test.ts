import { describe, expect, it } from 'vitest';
import { jsonSchemaToZod } from './schema.js';

describe('jsonSchemaToZod', () => {
  describe('object schemas', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' },
        nickname: { type: 'string' },
      },
      required: ['name', 'age'],
    });

    it('accepts valid data with all properties', () => {
      const result = schema.safeParse({ name: 'Ada', age: 36, nickname: 'al' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ name: 'Ada', age: 36, nickname: 'al' });
      }
    });

    it('accepts data omitting non-required properties', () => {
      expect(schema.safeParse({ name: 'Ada', age: 36 }).success).toBe(true);
    });

    it('rejects data missing a required property', () => {
      expect(schema.safeParse({ name: 'Ada' }).success).toBe(false);
    });

    it('rejects properties with the wrong type', () => {
      expect(schema.safeParse({ name: 'Ada', age: 'old' }).success).toBe(false);
    });

    it('rejects non-object values', () => {
      expect(schema.safeParse('nope').success).toBe(false);
      expect(schema.safeParse(null).success).toBe(false);
      expect(schema.safeParse([1, 2]).success).toBe(false);
    });

    it('treats an object without properties as an open record', () => {
      const open = jsonSchemaToZod({ type: 'object' });
      expect(open.safeParse({ anything: 1, goes: true }).success).toBe(true);
      expect(open.safeParse('not an object').success).toBe(false);
    });

    it('ignores non-string entries in required', () => {
      const s = jsonSchemaToZod({
        type: 'object',
        properties: { a: { type: 'string' } },
        required: [42, 'a'],
      });
      expect(s.safeParse({}).success).toBe(false);
      expect(s.safeParse({ a: 'x' }).success).toBe(true);
    });
  });

  describe('array schemas', () => {
    it('validates typed items', () => {
      const schema = jsonSchemaToZod({ type: 'array', items: { type: 'number' } });
      expect(schema.safeParse([1, 2.5, 3]).success).toBe(true);
      expect(schema.safeParse([1, 'two']).success).toBe(false);
      expect(schema.safeParse('not an array').success).toBe(false);
    });

    it('accepts any items when items is omitted', () => {
      const schema = jsonSchemaToZod({ type: 'array' });
      expect(schema.safeParse([1, 'two', null, { three: 3 }]).success).toBe(true);
    });

    it('handles nested arrays of objects', () => {
      const schema = jsonSchemaToZod({
        type: 'array',
        items: {
          type: 'object',
          properties: { title: { type: 'string' }, price: { type: 'number' } },
          required: ['title', 'price'],
        },
      });
      expect(schema.safeParse([{ title: 'A', price: 9.99 }]).success).toBe(true);
      expect(schema.safeParse([{ title: 'A' }]).success).toBe(false);
    });
  });

  describe('string and enum schemas', () => {
    it('validates plain strings', () => {
      const schema = jsonSchemaToZod({ type: 'string' });
      expect(schema.safeParse('hello').success).toBe(true);
      expect(schema.safeParse(42).success).toBe(false);
    });

    it('restricts string enums to listed values', () => {
      const schema = jsonSchemaToZod({ type: 'string', enum: ['red', 'green', 'blue'] });
      expect(schema.safeParse('green').success).toBe(true);
      expect(schema.safeParse('yellow').success).toBe(false);
    });

    it('supports a bare enum without a type keyword', () => {
      const schema = jsonSchemaToZod({ enum: ['on', 'off'] });
      expect(schema.safeParse('on').success).toBe(true);
      expect(schema.safeParse('maybe').success).toBe(false);
    });

    it('falls back to plain string for mixed-type enums', () => {
      const schema = jsonSchemaToZod({ type: 'string', enum: ['a', 1] });
      expect(schema.safeParse('anything').success).toBe(true);
      expect(schema.safeParse(1).success).toBe(false);
    });
  });

  describe('numeric, boolean, and null schemas', () => {
    it('validates numbers (floats allowed)', () => {
      const schema = jsonSchemaToZod({ type: 'number' });
      expect(schema.safeParse(3.14).success).toBe(true);
      expect(schema.safeParse('3.14').success).toBe(false);
    });

    it('validates integers (floats rejected)', () => {
      const schema = jsonSchemaToZod({ type: 'integer' });
      expect(schema.safeParse(7).success).toBe(true);
      expect(schema.safeParse(7.5).success).toBe(false);
    });

    it('validates booleans', () => {
      const schema = jsonSchemaToZod({ type: 'boolean' });
      expect(schema.safeParse(true).success).toBe(true);
      expect(schema.safeParse('true').success).toBe(false);
    });

    it('validates null', () => {
      const schema = jsonSchemaToZod({ type: 'null' });
      expect(schema.safeParse(null).success).toBe(true);
      expect(schema.safeParse(undefined).success).toBe(false);
      expect(schema.safeParse(0).success).toBe(false);
    });
  });

  describe('nullable type arrays', () => {
    it("['string', 'null'] accepts strings and null", () => {
      const schema = jsonSchemaToZod({ type: ['string', 'null'] });
      expect(schema.safeParse('text').success).toBe(true);
      expect(schema.safeParse(null).success).toBe(true);
      expect(schema.safeParse(5).success).toBe(false);
    });

    it("['null'] alone accepts only null", () => {
      const schema = jsonSchemaToZod({ type: ['null'] });
      expect(schema.safeParse(null).success).toBe(true);
      expect(schema.safeParse('x').success).toBe(false);
    });

    it('multi-type arrays become a union', () => {
      const schema = jsonSchemaToZod({ type: ['string', 'number', 'null'] });
      expect(schema.safeParse('x').success).toBe(true);
      expect(schema.safeParse(1).success).toBe(true);
      expect(schema.safeParse(null).success).toBe(true);
      expect(schema.safeParse(true).success).toBe(false);
    });

    it('an empty type array degrades to unknown', () => {
      const schema = jsonSchemaToZod({ type: [] });
      expect(schema.safeParse('anything').success).toBe(true);
      expect(schema.safeParse(null).success).toBe(true);
    });
  });

  describe('unknown-construct fallback', () => {
    it('unrecognized type strings degrade to unknown (accept everything)', () => {
      const schema = jsonSchemaToZod({ type: 'tuple' });
      for (const value of ['x', 1, null, [], {}]) {
        expect(schema.safeParse(value).success).toBe(true);
      }
    });

    it('schemas with no type and no enum degrade to unknown', () => {
      const schema = jsonSchemaToZod({ anyOf: [{ type: 'string' }] });
      expect(schema.safeParse(123).success).toBe(true);
    });

    it('non-object property nodes degrade to unknown', () => {
      const schema = jsonSchemaToZod({
        type: 'object',
        properties: { weird: true },
        required: ['weird'],
      });
      expect(schema.safeParse({ weird: ['anything'] }).success).toBe(true);
    });
  });

  describe('descriptions', () => {
    it('passes the description through to the zod schema', () => {
      const schema = jsonSchemaToZod({ type: 'string', description: 'A product title' });
      expect(schema.description).toBe('A product title');
      expect(schema.safeParse('ok').success).toBe(true);
    });

    it('passes nested property descriptions through', () => {
      const schema = jsonSchemaToZod({
        type: 'object',
        properties: { price: { type: 'number', description: 'GBP price' } },
        required: ['price'],
      });
      expect(schema.safeParse({ price: 1 }).success).toBe(true);
    });
  });
});
