/**
 * API payload types, replicated from packages/core/src/contracts.ts.
 *
 * The UI is a browser bundle and must not import @nanofish/core (which pulls
 * in playwright/node deps) — keep these in sync with the core contracts.
 */

export type RunKind = 'extract' | 'agent';

export type RunStatus = 'queued' | 'running' | 'success' | 'failed' | 'max_steps' | 'cancelled';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
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
  | 'run-finished';

export interface RunEvent {
  type: RunEventType;
  runId: string;
  batchId?: string;
  /** Present on run-step. */
  step?: StepRecord;
  /** Present on run-queued/run-started/run-finished. */
  record?: RunRecord;
  /** Present on run-screenshot. */
  screenshot?: { stepIndex: number; path: string };
}
