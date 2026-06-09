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
