/**
 * Shared contracts for nanofish core modules.
 *
 * Modules implement against these types:
 * - `llm/`      — LLM provider layer (Anthropic + OpenAI-compatible)
 * - `browser/`  — Playwright browser manager + page distillation
 * - `extract/`  — semantic extraction (page + schema -> validated JSON)
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
