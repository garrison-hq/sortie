import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunStore } from '../contracts.js';
import { createRunStore } from './store.js';

describe('login profiles (store)', () => {
  let dir: string;
  let store: RunStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sortie-profiles-'));
    store = createRunStore(join(dir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('upsertProfile / getProfile / listProfiles', () => {
    it('creates a profile with metadata and stamps createdAt', () => {
      const created = store.upsertProfile({
        name: 'sauce',
        domainHint: 'saucedemo.com',
        notes: 'standard_user',
      });

      expect(created.name).toBe('sauce');
      expect(created.domainHint).toBe('saucedemo.com');
      expect(created.notes).toBe('standard_user');
      expect(created.createdAt).toBeGreaterThan(0);
      expect(created.lastUsedAt).toBeUndefined();
      expect(store.getProfile('sauce')).toEqual(created);
    });

    it('upsert replaces metadata but keeps createdAt and lastUsedAt', () => {
      const created = store.upsertProfile({ name: 'sauce', domainHint: 'saucedemo.com' });
      store.touchProfile('sauce');

      const updated = store.upsertProfile({ name: 'sauce', notes: 'rotated' });
      expect(updated.createdAt).toBe(created.createdAt);
      expect(updated.lastUsedAt).toBeGreaterThan(0);
      expect(updated.notes).toBe('rotated');
      expect(updated.domainHint).toBeUndefined(); // metadata fields replace, not merge
    });

    it('rejects non-slug names', () => {
      expect(() => store.upsertProfile({ name: '../evil' })).toThrow(/invalid profile name/);
    });

    it('lists profiles sorted by name', () => {
      store.upsertProfile({ name: 'zeta' });
      store.upsertProfile({ name: 'alpha' });
      expect(store.listProfiles().map((p) => p.name)).toEqual(['alpha', 'zeta']);
    });
  });

  describe('touchProfile', () => {
    it('stamps lastUsedAt', () => {
      store.upsertProfile({ name: 'sauce' });
      store.touchProfile('sauce');
      expect(store.getProfile('sauce')?.lastUsedAt).toBeGreaterThan(0);
    });
  });

  describe('profileStatePath', () => {
    it('derives <dataDir>/profiles/<name>.json next to the database', () => {
      expect(store.profileStatePath('sauce')).toBe(join(dir, 'profiles', 'sauce.json'));
    });

    it('throws on path-traversal names instead of building a path', () => {
      for (const name of ['../evil', 'a/b', String.raw`a\b`, '.hidden', 'UPPER']) {
        expect(() => store.profileStatePath(name), name).toThrow(/invalid profile name/);
      }
    });
  });

  describe('deleteProfile', () => {
    it('removes the metadata row AND the on-disk state file', () => {
      store.upsertProfile({ name: 'sauce' });
      const statePath = store.profileStatePath('sauce');
      mkdirSync(join(dir, 'profiles'), { recursive: true });
      writeFileSync(statePath, JSON.stringify({ cookies: [], origins: [] }));

      expect(store.deleteProfile('sauce')).toBe(true);
      expect(store.getProfile('sauce')).toBeUndefined();
      expect(existsSync(statePath)).toBe(false);
      expect(store.deleteProfile('sauce')).toBe(false);
    });

    it('succeeds when no state file was ever written', () => {
      store.upsertProfile({ name: 'fresh' });
      expect(store.deleteProfile('fresh')).toBe(true);
    });

    it('refuses traversal names before touching the filesystem', () => {
      expect(() => store.deleteProfile('../evil')).toThrow(/invalid profile name/);
    });
  });
});
