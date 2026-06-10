import { describe, expect, it } from 'vitest';
import { isSlug, SLUG_PATTERN } from './naming.js';

describe('isSlug', () => {
  it('accepts lowercase names with digits, hyphens, and underscores', () => {
    for (const name of ['sauce', 'books-page-2', 'q_1', 'a', '0day', 'x'.repeat(64)]) {
      expect(isSlug(name), name).toBe(true);
    }
  });

  it('rejects path traversal, separators, uppercase, and other unsafe names', () => {
    for (const name of [
      '',
      '../etc/passwd',
      'a/b',
      'a\\b',
      'a.b',
      '.hidden',
      '-leading-dash',
      '_leading_underscore',
      'UPPER',
      'space name',
      'x'.repeat(65),
    ]) {
      expect(isSlug(name), JSON.stringify(name)).toBe(false);
    }
  });

  it('exports the pattern used by error messages', () => {
    expect(SLUG_PATTERN.source).toBe('^[a-z0-9][a-z0-9_-]{0,63}$');
  });
});
