/**
 * @nanofish/core — public API.
 *
 * Re-exports the shared contracts plus the LLM provider layer, browser
 * layer, and semantic extraction module.
 */
export const VERSION = '0.1.0';

// Shared contracts (single source of truth for all cross-module types).
export type {
  ToolDefinition,
  ToolCall,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  TokenUsage,
  LlmProvider,
  ProviderConfig,
  BrowserLaunchOptions,
  PageSessionOptions,
  DistilledElement,
  PageSnapshot,
  DistillPageFn,
  ResolveRefFn,
  ExtractOptions,
  ExtractResult,
} from './contracts.js';

// LLM provider layer. (Contract types re-exported by llm/index.js are
// intentionally not re-exported here — they come from contracts.js above.)
export {
  createProvider,
  AnthropicProvider,
  OpenAiProvider,
  DEFAULT_OPENAI_BASE_URL,
} from './llm/index.js';
export type { AnthropicProviderOptions, OpenAiProviderOptions } from './llm/index.js';

// Browser layer.
export { BrowserManager, withPage, distillPage, resolveRef } from './browser/index.js';
export type { WithPageOptions } from './browser/index.js';

// Semantic extraction.
export {
  extract,
  navigateAndSettle,
  jsonSchemaToZod,
  EXTRACTION_SYSTEM_PROMPT,
} from './extract/index.js';
