/** Small presentation helpers shared across views. */

export const SHORT_RUN_ID_CHARS = 8;

export function shortId(id: string): string {
  return id.slice(0, SHORT_RUN_ID_CHARS);
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** "just now" / "42s ago" / "5m ago" / "3h ago" / "2d ago". */
export function relativeTime(ts: number, now: number): string {
  const seconds = Math.floor(Math.max(0, now - ts) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** "850ms" / "12.3s" / "2m 05s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}m ${String(rest).padStart(2, '0')}s`;
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Mirrors core's SLUG_PATTERN — valid saved-query / profile names. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function isSlug(name: string): boolean {
  return SLUG_PATTERN.test(name);
}
