/**
 * Shared contracts for nanofish core modules.
 *
 * Modules implement against these types:
 * - `llm/`      — LLM provider layer (Anthropic + OpenAI-compatible)
 * - `browser/`  — Playwright browser manager + page distillation
 * - `extract/`  — semantic extraction (page + schema -> validated JSON)
 * - `search/`   — web search (SearXNG-first, browser-engine fallback)
 * - `fetch/`    — URL -> clean main-content Markdown (HTML or PDF)
 * - `pdf/`      — PDF download + text extraction
 */
import type { Page, Locator } from 'playwright';
import type { z } from 'zod';

// ---------------------------------------------------------------------------
// LLM provider layer
// ---------------------------------------------------------------------------

/** JSON Schema object describing a tool's input. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export type ChatMessage =
  | { role: 'user' | 'assistant'; content: string }
  | { role: 'assistant'; content: string; toolCalls: ToolCall[] }
  | { role: 'toolResult'; toolCallId: string; content: string };

export interface ChatRequest {
  system?: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  /** 'required' forces some tool call; { name } forces a specific tool. */
  toolChoice?: 'auto' | 'required' | { name: string };
  maxTokens?: number;
  temperature?: number;
}

export interface ChatResponse {
  text: string | null;
  toolCalls: ToolCall[];
  stopReason: 'end' | 'tool_use' | 'max_tokens' | 'other';
  usage: TokenUsage;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmProvider {
  /** e.g. "anthropic:claude-sonnet-4-6" or "openai:gpt-4o@http://localhost:11434/v1" */
  readonly id: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

export interface ProviderConfig {
  provider: 'anthropic' | 'openai';
  model?: string;
  apiKey?: string;
  /** OpenAI-compatible endpoint override (Ollama, vLLM, OpenRouter, ...). */
  baseUrl?: string;
}

// ---------------------------------------------------------------------------
// Browser layer
// ---------------------------------------------------------------------------

export interface BrowserLaunchOptions {
  headless?: boolean;
}

export interface PageSessionOptions {
  /** Path to a Playwright storage-state JSON for session reuse (logins). */
  storageStatePath?: string;
}

export interface DistilledElement {
  /** Stable handle resolvable to a Locator via resolveRef(). */
  ref: string;
  /** ARIA role (or tag-derived fallback). */
  role: string;
  /** Accessible name / visible text, truncated. */
  name: string;
  tag: string;
  href?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  /** Inside an open dialog/modal or fixed high-z-index layer (cookie banner,
   * popup) — surfaced first in the outline so truncation never hides it. */
  overlay?: boolean;
}

export interface PageSnapshot {
  url: string;
  title: string;
  /** Compact LLM-readable outline of the page: roles, names, refs, structure. */
  outline: string;
  /** Interactive + salient elements, programmatically addressable. */
  elements: DistilledElement[];
  /** Trimmed visible text content of the page. */
  text: string;
}

/** Implemented by browser/distill.ts */
export type DistillPageFn = (page: Page) => Promise<PageSnapshot>;
export type ResolveRefFn = (page: Page, ref: string) => Locator;

// ---------------------------------------------------------------------------
// Semantic extraction
// ---------------------------------------------------------------------------

export interface ExtractOptions<T> {
  /** URL to navigate to. Omit if passing an existing `page`. */
  url?: string;
  /** Reuse an already-open page instead of navigating. */
  page?: Page;
  /** Pre-built snapshot — skips navigation and distillation entirely
   * (used for PDF documents, which have no live DOM to distill). */
  snapshot?: PageSnapshot;
  /** zod schema the result must validate against. */
  schema: z.ZodType<T>;
  /** Natural-language hint about what to extract, e.g. "the product list". */
  instruction?: string;
  provider?: LlmProvider;
}

export interface ExtractResult<T> {
  data: T;
  url: string;
  usage: TokenUsage;
}

// ---------------------------------------------------------------------------
// Web search
// ---------------------------------------------------------------------------

/** Browser-driven search engines, in default fallback order. */
export type SearchEngineId = 'bing' | 'duckduckgo' | 'brave';

export interface SearchResult {
  title: string;
  /** Absolute http(s) URL. */
  url: string;
  snippet: string;
  /** Engine that produced the result (browser fallback path only). */
  engine?: SearchEngineId;
  /** 1-based rank within the returned list. */
  position: number;
}

export interface SearchOptions {
  /** Number of results to return. Default 10, clamped to 1..20. */
  maxResults?: number;
  /** Browser-engine fallback order. Default: bing, duckduckgo, brave. */
  engines?: SearchEngineId[];
  /** SearXNG instance to query first; defaults to $SEARXNG_BASE_URL. */
  searxngBaseUrl?: string;
  /** LLM provider for the semantic SERP-parse fallback. */
  provider?: LlmProvider;
  /** Reuse an already-open page for browser-engine searches. */
  page?: Page;
  headless?: boolean;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  /** Backend that answered: SearXNG or the first non-challenged engine. */
  source: 'searxng' | SearchEngineId;
}

/** Callable search backend (powers the agent's `search` tool). */
export interface SearchProvider {
  search(query: string, opts?: SearchOptions): Promise<SearchResponse>;
}

// ---------------------------------------------------------------------------
// URL -> Markdown fetch (HTML or PDF)
// ---------------------------------------------------------------------------

export interface FetchPageOptions {
  url: string;
  /** Reuse an already-open page instead of launching a browser. */
  page?: Page;
  /** Cap on markdown/text length. Default 80_000 (queued runs use 40_000). */
  maxChars?: number;
  /** Also collect absolute links from the main content. */
  includeLinks?: boolean;
  storageStatePath?: string;
  headless?: boolean;
}

export interface FetchPageResult {
  /** URL as requested. */
  url: string;
  /** URL after redirects. */
  finalUrl: string;
  title: string;
  /** Clean main-content Markdown (boilerplate stripped). */
  markdown: string;
  /** Plain-text rendering of the same content. */
  text: string;
  /** Present when `includeLinks` was set. */
  links?: { text: string; url: string }[];
  contentType: 'html' | 'pdf';
  /** True when the content was cut at `maxChars`. */
  truncated: boolean;
}

/** Parsed PDF content (capped at download/page/char limits). */
export interface PdfDocument {
  /** Title from PDF metadata, when present. */
  title?: string;
  /** Total pages in the document (before any page cap). */
  numPages: number;
  /** Extracted text, one entry per included page. */
  pages: string[];
  /** True when the page or character caps cut content. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Multi-step agent loop
// ---------------------------------------------------------------------------

export type AgentStatus = 'success' | 'failed' | 'max_steps';

export interface AgentRunOptions<T> {
  /** Natural-language goal, e.g. "log in, add the backpack to the cart, ..." */
  goal: string;
  startUrl: string;
  /** Schema for the final structured output (submitted via the done tool). */
  schema?: z.ZodType<T>;
  provider?: LlmProvider;
  /** Reuse an existing page; otherwise a browser is launched and cleaned up. */
  page?: Page;
  /** Hard cap on agent steps. Default 25. */
  maxSteps?: number;
  headless?: boolean;
  storageStatePath?: string;
  /**
   * Named secrets. The model references them as "{{cred:NAME}}" in type-tool
   * input; the executor substitutes real values. Raw values must never appear
   * in prompts, traces, or logs.
   */
  credentials?: Record<string, string>;
  /** Live observer for each completed step (powers the UI live view). */
  onStep?: (step: StepRecord) => void;
}

export interface AgentAction {
  /** navigate | click | type | select | scroll | wait | extract | done | fail */
  tool: string;
  /** Tool-specific input as produced by the model (credentials unresolved). */
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

export interface AgentRunResult<T> {
  status: AgentStatus;
  /** Present when status === 'success'. */
  output?: T;
  failureReason?: string;
  steps: StepRecord[];
  usage: TokenUsage;
  finalUrl: string;
}

// ---------------------------------------------------------------------------
// Runtime: persistence, queue, batches
// ---------------------------------------------------------------------------

export type RunKind = 'extract' | 'agent' | 'fetch';
export type RunStatus = 'queued' | 'running' | 'success' | 'failed' | 'max_steps' | 'cancelled';

/** Serializable description of a run — everything needed to (re)execute it. */
export interface RunSpec {
  kind: RunKind;
  /** Target URL (extract/fetch) or start URL (agent). */
  url: string;
  /** User-provided JSON Schema for the structured output. */
  schemaJson?: Record<string, unknown>;
  /** Extraction hint (kind: extract). */
  instruction?: string;
  /** Agent goal (kind: agent). */
  goal?: string;
  maxSteps?: number;
  /** Env var NAMES to expose as credentials; values resolved at execution time. */
  credentialNames?: string[];
  storageStatePath?: string;
  /** Named login profile, resolved to its storage-state path at execution
   * time. Mutually exclusive with `storageStatePath`. */
  profile?: string;
  /** Saved query this run was replayed from (run-history link-back). */
  queryName?: string;
  /** Markdown length cap (kind: fetch). Queued runs default to 40_000. */
  maxChars?: number;
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

export interface ListRunsOptions {
  limit?: number;
  offset?: number;
  batchId?: string;
  status?: RunStatus;
  /** Filter to runs replayed from a saved query (spec.queryName). */
  queryName?: string;
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

/** Metadata for a named login profile. The storage-state JSON itself lives
 * only on disk at `<dataDir>/profiles/<name>.json` and is never stored in
 * the database or returned by any API. */
export interface ProfileRecord {
  /** Slug name; also the storage-state file's basename. */
  name: string;
  /** Site the profile logs into, e.g. "saucedemo.com" (informational). */
  domainHint?: string;
  notes?: string;
  createdAt: number;
  lastUsedAt?: number;
}

/** SQLite-backed persistence for runs, steps, results, saved queries, and
 * login-profile metadata. */
export interface RunStore {
  createRun(spec: RunSpec, batchId?: string): RunRecord;
  updateRun(id: string, patch: Partial<Omit<RunRecord, 'id' | 'spec' | 'createdAt'>>): RunRecord;
  getRun(id: string): RunRecord | undefined;
  listRuns(opts?: ListRunsOptions): RunRecord[];
  countRuns(opts?: Pick<ListRunsOptions, 'batchId' | 'status' | 'queryName'>): number;
  appendStep(runId: string, step: StepRecord): void;
  getSteps(runId: string): StepRecord[];
  /** Serialize finished runs' outputs. CSV flattens one row per run (or per
   * array item when every output is an object with a single array field). */
  exportRuns(opts: { batchId?: string; runIds?: string[]; format: 'json' | 'csv' }): string;

  // Saved queries (v1: kind 'extract' only).
  /** Throws on non-slug names, non-extract specs, and duplicate names. */
  createQuery(name: string, spec: RunSpec): SavedQuery;
  /** Replace an existing query's spec. Throws on unknown names. */
  updateQuery(name: string, spec: RunSpec): SavedQuery;
  getQuery(name: string): SavedQuery | undefined;
  listQueries(): SavedQuery[];
  /** Returns false when no query by that name existed. */
  deleteQuery(name: string): boolean;
  /** Bump runCount and lastRunAt after a replay is submitted. */
  recordQueryRun(name: string): void;

  // Login profiles (metadata only — state JSON stays on disk).
  upsertProfile(profile: Pick<ProfileRecord, 'name' | 'domainHint' | 'notes'>): ProfileRecord;
  getProfile(name: string): ProfileRecord | undefined;
  listProfiles(): ProfileRecord[];
  /** Removes the metadata row AND the on-disk state file. Returns false when
   * no profile by that name existed. */
  deleteProfile(name: string): boolean;
  /** Stamp lastUsedAt = now (called when a run resolves the profile). */
  touchProfile(name: string): void;
  /** Absolute-or-relative path of the profile's storage-state file, derived
   * from the slug (never stored). Throws on non-slug names. */
  profileStatePath(name: string): string;

  close(): void;
}

export interface RunEvent {
  type: 'run-queued' | 'run-started' | 'run-step' | 'run-screenshot' | 'run-finished';
  runId: string;
  batchId?: string;
  /** Present on run-step. */
  step?: StepRecord;
  /** Present on run-queued/run-started/run-finished. */
  record?: RunRecord;
  /** Present on run-screenshot: JPEG saved to disk for live view + replay. */
  screenshot?: { stepIndex: number; path: string };
}

export interface QueueOptions {
  /** Parallel browser workers. Default 5, clamp 1..10. */
  concurrency?: number;
  /** Minimum ms between run starts against the same domain. Default 1000. */
  perDomainIntervalMs?: number;
  /** Re-attempts for infrastructure failures (timeouts, crashes) — NOT for
   * agent-reported 'failed' outcomes. Default 2. */
  maxRetries?: number;
  provider?: LlmProvider;
  /** Per-step JPEG screenshots for live view + replay. Default enabled;
   * stored under `dir` (default $NANOFISH_DATA_DIR/screenshots/<runId>/). */
  screenshots?: { enabled?: boolean; dir?: string };
}

/** In-process run queue executing RunSpecs against a worker pool. */
export interface RunQueue {
  submit(spec: RunSpec): RunRecord;
  submitBatch(specs: RunSpec[]): { batchId: string; runs: RunRecord[] };
  cancel(runId: string): boolean;
  /** Subscribe to lifecycle events; returns an unsubscribe function. */
  onEvent(listener: (ev: RunEvent) => void): () => void;
  /** Resolves when all currently queued/running work has settled. */
  drain(): Promise<void>;
  /** Stop workers and close the shared browser. */
  shutdown(): Promise<void>;
}
