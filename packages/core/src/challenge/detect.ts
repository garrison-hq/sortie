/**
 * Shared challenge / CAPTCHA detection module (T004).
 *
 * Single source of truth for all challenge-detection logic. Used by:
 *  - `search/engines.ts`  — SERP bot-wall detection (was inline there)
 *  - `agent/loop.ts`      — page-level challenge detection while running (WP03)
 *
 * IMPORTANT — C-001: this module ONLY detects challenges, it never attempts
 * to solve or bypass them.
 */
import type { Page } from 'playwright';
import type { ChallengeDetection, ChallengeFamily, PageSnapshot } from '../contracts.js';

// ---------------------------------------------------------------------------
// Marker / signal constants — single source of truth
// ---------------------------------------------------------------------------

/** How much body text (chars) to inspect for markers. */
const CHALLENGE_TEXT_LIMIT = 4_000;

/** reCAPTCHA frame URL fragments. */
const RECAPTCHA_FRAME_PATTERNS = ['recaptcha.net/recaptcha', 'google.com/recaptcha'] as const;

/** hCaptcha frame URL fragment. */
const HCAPTCHA_FRAME_PATTERN = 'hcaptcha.com' as const;

/** Cloudflare Turnstile / challenge interstitial patterns. */
const CLOUDFLARE_FRAME_PATTERN = 'challenges.cloudflare.com' as const;
const CLOUDFLARE_BODY_MARKERS = ['cf-chl', 'checking your browser', 'just a moment'] as const;

/** Generic bot-wall text markers (case-insensitive).
 * Order matters: more-specific tokens (grecaptcha, recaptcha, hcaptcha) must
 * come before the shorter 'captcha' substring so classifyGenericMarker assigns
 * the correct family when the page only contains, e.g., "grecaptcha". */
const GENERIC_MARKERS = [
  'grecaptcha',
  'recaptcha',
  'hcaptcha',
  'captcha',
  'unusual traffic',
  'are you a robot',
  'verify you are human',
  'verifying you are human',
  'verify you are not a robot',
] as const;

/** DuckDuckGo-specific anomaly modal marker. */
const DDG_ANOMALY_MARKER = 'bots use duckduckgo' as const;

// ---------------------------------------------------------------------------
// Pure detection function
// ---------------------------------------------------------------------------

export interface DetectChallengeInput {
  /** HTTP response status (0 if unavailable). */
  status: number;
  /** Page <title>. */
  title: string;
  /** Visible body text (any length — we cap internally). */
  bodyText: string;
  /** Current page URL. */
  url: string;
  /** iframe src URLs on the page (optional, enables frame-based detection). */
  frameUrls?: string[];
}

/**
 * Pure, synchronous challenge detector. Returns a `ChallengeDetection` when a
 * challenge is found, or `null` for a normal page.
 *
 * Check order: HTTP status → frame src → content markers.
 */
export function detectChallenge(input: DetectChallengeInput): ChallengeDetection | null {
  const { status, title, bodyText, frameUrls = [] } = input;

  // 1. HTTP-status gate — 403/429 are definitive regardless of content.
  if (status === 403 || status === 429) {
    return {
      detected: true,
      family: 'http',
      signal: `HTTP ${status}`,
      via: 'http',
    };
  }

  // 2. Frame-URL inspection (highest fidelity for JS-rendered challenges).
  for (const src of frameUrls) {
    const lower = src.toLowerCase();

    if (RECAPTCHA_FRAME_PATTERNS.some((p) => lower.includes(p))) {
      return { detected: true, family: 'recaptcha', signal: src, via: 'frame' };
    }
    if (lower.includes(HCAPTCHA_FRAME_PATTERN)) {
      return { detected: true, family: 'hcaptcha', signal: src, via: 'frame' };
    }
    if (lower.includes(CLOUDFLARE_FRAME_PATTERN)) {
      return { detected: true, family: 'turnstile', signal: src, via: 'frame' };
    }
  }

  // 3. Content inspection (title + capped body text).
  const haystack = `${title}\n${bodyText.slice(0, CHALLENGE_TEXT_LIMIT)}`.toLowerCase();

  // Cloudflare body markers (interstitials that don't use an iframe).
  for (const marker of CLOUDFLARE_BODY_MARKERS) {
    if (haystack.includes(marker)) {
      return { detected: true, family: 'cloudflare', signal: marker, via: 'content' };
    }
  }

  // DuckDuckGo anomaly modal.
  if (haystack.includes(DDG_ANOMALY_MARKER)) {
    return { detected: true, family: 'generic', signal: DDG_ANOMALY_MARKER, via: 'content' };
  }

  // Generic markers — covers reCAPTCHA/hCaptcha titles, "unusual traffic", etc.
  for (const marker of GENERIC_MARKERS) {
    if (haystack.includes(marker)) {
      return classifyGenericMarker(marker);
    }
  }

  return null;
}

/** Map a generic text marker to the most specific family we can infer. */
function classifyGenericMarker(marker: string): ChallengeDetection {
  let family: ChallengeFamily = 'generic';
  if (marker === 'recaptcha' || marker === 'grecaptcha') family = 'recaptcha';
  else if (marker === 'hcaptcha') family = 'hcaptcha';
  return { detected: true, family, signal: marker, via: 'marker' };
}

// ---------------------------------------------------------------------------
// Minimal DOM interface types for page.evaluate callbacks
// (same pattern as search/engines.ts — this package excludes the "dom" lib)
// ---------------------------------------------------------------------------

interface MinimalElement {
  getAttribute(name: string): string | null;
}
interface MinimalNodeList {
  length: number;
  [index: number]: MinimalElement | undefined;
  [Symbol.iterator](): Iterator<MinimalElement>;
}
interface MinimalBody {
  innerText?: string;
}
interface MinimalDocument {
  querySelectorAll(selector: string): MinimalNodeList;
  body: MinimalBody | null;
}
interface MinimalWindow {
  document: MinimalDocument;
}

// ---------------------------------------------------------------------------
// Page-aware wrapper
// ---------------------------------------------------------------------------

/**
 * Page-aware wrapper: reads HTTP status, title, body text, and iframe src
 * attributes from the live Playwright page, then delegates to `detectChallenge`.
 *
 * Falls back gracefully — if `page.evaluate` throws (e.g. page crashed), the
 * text/frame inputs are treated as empty and detection continues.
 */
export async function detectChallengeOnPage(
  page: Page,
  snapshot: PageSnapshot,
): Promise<ChallengeDetection | null> {
  // Title comes from the already-distilled snapshot (cheap, no extra call).
  const title = snapshot.title;
  const url = snapshot.url;

  // Collect iframe srcs via evaluate (frame detection; best-effort).
  let frameUrls: string[] = [];
  try {
    frameUrls = await page.evaluate((): string[] => {
      const doc = (globalThis as unknown as MinimalWindow).document;
      const frames = doc.querySelectorAll('iframe[src]');
      const srcs: string[] = [];
      for (const frame of frames) {
        const src = frame.getAttribute('src');
        if (src) srcs.push(src);
      }
      return srcs;
    });
  } catch {
    // Non-fatal — continue without frame inspection.
  }

  // Body text for content markers (capped; best-effort).
  let bodyText = '';
  try {
    bodyText = await page.evaluate((limit: number): string => {
      const doc = (globalThis as unknown as MinimalWindow).document;
      const text = doc.body && typeof doc.body.innerText === 'string' ? doc.body.innerText : '';
      return text.slice(0, limit);
    }, CHALLENGE_TEXT_LIMIT);
  } catch {
    // Non-fatal — empty body text may still detect via HTTP status or frames.
  }

  // HTTP status via the most-recently-committed navigation response.
  // Playwright doesn't expose the current response directly; we use 0 as the
  // "unknown" sentinel. Callers in search/engines.ts pass the status explicitly
  // via the pure detectChallenge(); the page-aware path focuses on frame/content.
  const status = 0;

  return detectChallenge({ status, title, bodyText, url, frameUrls });
}

// ---------------------------------------------------------------------------
// Search-engine compatibility helpers (used by search/engines.ts — T005)
// ---------------------------------------------------------------------------

/**
 * Convert a `ChallengeDetection` to the short human-readable reason string
 * that `SearchChallengeError` has always expected.
 *
 * Preserves exact wording for DuckDuckGo anomaly and HTTP-status messages so
 * existing `search/engines.test.ts` assertions stay green.
 */
export function detectionToReason(detection: ChallengeDetection): string {
  if (detection.via === 'http') {
    return `HTTP ${detection.signal.replace('HTTP ', '')} (blocked or rate-limited)`;
  }
  if (detection.signal === DDG_ANOMALY_MARKER) {
    return 'DuckDuckGo anomaly challenge modal';
  }
  return `challenge page detected ("${detection.signal}")`;
}

/**
 * Engine-aware wrapper used by `search/engines.ts`.
 *
 * Adds engine-specific signals (DuckDuckGo HTTP 202) on top of the shared
 * detector, then converts the result to the legacy `string | null` shape that
 * `SearchChallengeError` accepts.
 */
export function detectChallengeForEngine(
  engine: string,
  status: number,
  title: string,
  bodyText: string,
): string | null {
  // Engine-specific pre-check: DDG HTTP 202 is a bot challenge.
  if (engine === 'duckduckgo' && status === 202) {
    return 'HTTP 202 (DuckDuckGo bot challenge)';
  }

  const detection = detectChallenge({ status, title, bodyText, url: '' });
  if (!detection) return null;

  return detectionToReason(detection);
}
