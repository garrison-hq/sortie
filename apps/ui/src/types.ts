/**
 * API payload types, replicated from packages/core/src/contracts.ts.
 *
 * The UI is a browser bundle and must not import @garrison-hq/sortie (which pulls
 * in playwright/node deps) — keep these in sync with the core contracts.
 */

export type RunKind = 'extract' | 'agent' | 'fetch';

export type RunStatus =
  | 'queued'
  | 'running'
  | 'success'
  | 'failed'
  | 'max_steps'
  | 'cancelled'
  | 'awaiting_human';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Pause state attached to a run while it is `awaiting_human`. */
export interface AssistState {
  family: string;
  signal: string;
  stepIndex: number;
  challengeUrl: string;
  /** Epoch ms when the run was paused. */
  pausedAt: number;
  /** Epoch ms when the solve window expires. */
  deadlineAt: number;
  resolvedAt?: number;
  resolution?: 'solved' | 'timeout' | 'cancelled';
  solveSource?: 'auto' | 'manual';
}

/** Serializable description of a run — everything needed to (re)execute it. */
export interface RunSpec {
  kind: RunKind;
  /** Target URL (extract) or start URL (agent). */
  url: string;
  /** User-provided JSON Schema for the structured output. */
  schemaJson?: Record<string, unknown>;
  /** Extraction hint (kind: extract). */
  instruction?: string;
  /** Agent goal (kind: agent). */
  goal?: string;
  maxSteps?: number;
  /** Env var NAMES to expose as credentials; values resolved server-side. */
  credentialNames?: string[];
  storageStatePath?: string;
  /** Named login profile, resolved to its storage-state path server-side.
   * Mutually exclusive with `storageStatePath`. */
  profile?: string;
  /** Saved query this run was replayed from (run-history link-back). */
  queryName?: string;
  /** Markdown length cap (kind: fetch). */
  maxChars?: number;
  /** Enable human-in-the-loop CAPTCHA assistance. Default false. FR-001. */
  assist?: boolean;
}

/** A named, replayable run spec (v1: extract specs only). */
export interface SavedQuery {
  id: string;
  /** Slug name, unique across saved queries. */
  name: string;
  spec: RunSpec;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  runCount: number;
}

/** Per-replay overrides applied on top of a saved query's spec. */
export interface QueryRunOverrides {
  url?: string;
  instruction?: string;
}

/** Deterministic, value-free staleness summary of a profile's storage state. */
export interface ProfileStateSummary {
  /** False when no state file exists (all other fields are zero/empty). */
  exists: boolean;
  cookieCount: number;
  /** Cookies with no expiry (browser-session lifetime). */
  sessionCookieCount: number;
  /** Persistent cookies whose expiry is already in the past. */
  expiredCookieCount: number;
  /** Unique cookie domains, leading "." stripped, sorted. */
  domains: string[];
  /** Earliest expiry among persistent cookies (epoch ms). */
  earliestExpiresAt?: number;
}

/** Login-profile metadata + state summary as served by GET /api/profiles.
 * The storage-state JSON itself never leaves the server. */
export interface ProfileInfo {
  /** Slug name; also the storage-state file's basename on the server. */
  name: string;
  /** Site the profile logs into, e.g. "saucedemo.com" (informational). */
  domainHint?: string;
  notes?: string;
  createdAt: number;
  lastUsedAt?: number;
  state: ProfileStateSummary;
}

export interface RunRecord {
  id: string;
  spec: RunSpec;
  status: RunStatus;
  batchId?: string;
  attempts: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  output?: unknown;
  failureReason?: string;
  usage?: TokenUsage;
  finalUrl?: string;
  /** Present when the run is (or was) paused for CAPTCHA assistance. */
  assist?: AssistState;
}

export interface AgentAction {
  /** navigate | click | type | select | scroll | wait | extract | done | fail */
  tool: string;
  input: Record<string, unknown>;
}

export interface StepRecord {
  index: number;
  url: string;
  title: string;
  /** Model's reasoning text accompanying the action ('' if none). */
  thought: string;
  action: AgentAction;
  /** Executor result summary or error message fed back to the model. */
  observation: string;
  startedAt: number;
  durationMs: number;
}

export type RunEventType =
  | 'run-queued'
  | 'run-started'
  | 'run-step'
  | 'run-screenshot'
  | 'run-finished'
  | 'run-awaiting-human'
  | 'run-resumed';

export type RunEvent =
  | {
      type: 'run-queued' | 'run-started' | 'run-finished' | 'run-step' | 'run-screenshot';
      runId: string;
      batchId?: string;
      /** Present on run-step. */
      step?: StepRecord;
      /** Present on run-queued/run-started/run-finished. */
      record?: RunRecord;
      /** Present on run-screenshot. */
      screenshot?: { stepIndex: number; path: string };
    }
  | {
      type: 'run-awaiting-human';
      runId: string;
      batchId?: string;
      assist: AssistState;
    }
  | {
      type: 'run-resumed';
      runId: string;
      batchId?: string;
      resolution: 'solved' | 'cancelled';
      solveSource?: 'auto' | 'manual';
    };

/** Live-view message frame metadata (R4 coordinate mapping). */
export interface LvFrameMetadata {
  offsetTop: number;
  pageScaleFactor: number;
  deviceWidth: number;
  deviceHeight: number;
}

/** Client→server live-view message union. */
export type LvClientMessage =
  | { t: 'lv:attach'; runId: string }
  | { t: 'lv:detach'; runId: string }
  | {
      t: 'lv:mouse';
      runId: string;
      event: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel';
      x: number;
      y: number;
      button?: 'left' | 'right' | 'middle' | 'none';
      buttons?: number;
      clickCount?: number;
      deltaX?: number;
      deltaY?: number;
    }
  | {
      t: 'lv:key';
      runId: string;
      event: 'keyDown' | 'keyUp' | 'char';
      key?: string;
      code?: string;
      text?: string;
      modifiers?: number;
    }
  | { t: 'lv:resume'; runId: string }
  | { t: 'lv:cancel'; runId: string };
