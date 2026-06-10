/**
 * @nanofish/core — public API.
 *
 * Re-exports the shared contracts plus the LLM provider layer, browser
 * layer, semantic extraction module, agent loop, and the persisted runtime
 * (SQLite run store + in-process run queue).
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
  AgentStatus,
  AgentRunOptions,
  AgentAction,
  StepRecord,
  AgentRunResult,
  RunKind,
  RunStatus,
  RunSpec,
  RunRecord,
  ListRunsOptions,
  RunStore,
  RunEvent,
  QueueOptions,
  RunQueue,
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

// Multi-step agent loop.
export { runAgent } from './agent/loop.js';
export { AGENT_TOOLS, executeAction } from './agent/tools.js';
export type { ExecutionContext } from './agent/tools.js';
export { buildAgentSystemPrompt } from './agent/prompts.js';
export type { AgentSystemPromptOptions } from './agent/prompts.js';

// Persistence (SQLite run store).
export { createRunStore, openDatabase, exportRuns } from './store/index.js';
export type { RunRow, ExportRunsOptions } from './store/index.js';

// Run queue (in-process worker pool over the persisted store).
export { createRunQueue } from './runtime/index.js';
export type { ExecuteRunFn, ExecuteRunOutcome } from './runtime/index.js';
