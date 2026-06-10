/**
 * Slug validation for user-supplied names that become identifiers or file
 * paths (saved queries, login profiles). The pattern doubles as a
 * path-traversal defense: profile storage-state paths are derived from the
 * slug, so anything outside [a-z0-9_-] (e.g. "../", "/") must be rejected
 * before it reaches the filesystem.
 */

/** Lowercase alphanumeric start, then up to 63 more of [a-z0-9_-]. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** True when `value` is a valid nanofish slug (query/profile name). */
export function isSlug(value: string): boolean {
  return SLUG_PATTERN.test(value);
}
