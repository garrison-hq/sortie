/**
 * @garrison-hq/sortie — public API.
 *
 * Re-exports the shared contracts plus the LLM provider layer, browser
 * layer, semantic extraction module, agent loop, and the persisted runtime
 * (SQLite run store + in-process run queue).
 */
export const VERSION = '1.0.0-pre.1';

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
  SearchEngineId,
  SearchResult,
  SearchOptions,
  SearchResponse,
  SearchProvider,
  FetchPageOptions,
  FetchPageResult,
  PdfDocument,
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
  SavedQuery,
  QueryRunOverrides,
  ProfileRecord,
  RunStore,
  RunEvent,
  QueueOptions,
  RunQueue,
  // Live-view WebSocket protocol (WP01/WP05)
  LvClientMessage,
  LvServerMessage,
  LvAttach,
  LvDetach,
  LvMouse,
  LvKey,
  LvResume,
  LvCancel,
  LvStarted,
  LvFrame,
  LvStopped,
} from './contracts.js';

export {
  // Live-view zod schemas — needed by ws.ts to validate inbound messages.
  LvClientMessageSchema,
  LvServerMessageSchema,
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
  navigateOrPdfSnapshot,
  jsonSchemaToZod,
  EXTRACTION_SYSTEM_PROMPT,
} from './extract/index.js';

// Web search (SearXNG-first, browser-engine fallback chain).
export { search, createSearchProvider, normalizeResults, clampMaxResults } from './search/index.js';

// URL -> Markdown fetch (HTML or PDF).
export {
  fetchPage,
  FETCH_MAX_CHARS,
  collectLinks,
  extractArticle,
  htmlToMarkdown,
  markdownToText,
  stripBoilerplate,
} from './fetch/index.js';
export type { ArticleContent } from './fetch/index.js';

// PDF download + text extraction.
export {
  isPdfUrl,
  sniffPdfResponse,
  downloadPdf,
  pdfToDocument,
  pdfToMarkdown,
  pdfToSnapshot,
  PDF_MAX_BYTES,
  PDF_MAX_PAGES,
  PDF_MAX_CHARS,
  PDF_SNAPSHOT_OUTLINE,
} from './pdf/index.js';
export type { DownloadPdfOptions, PdfToDocumentOptions } from './pdf/index.js';

// Multi-step agent loop.
export { runAgent } from './agent/loop.js';
export { AGENT_TOOLS, executeAction } from './agent/tools.js';
export type { ExecutionContext } from './agent/tools.js';
export { buildAgentSystemPrompt } from './agent/prompts.js';
export type { AgentSystemPromptOptions } from './agent/prompts.js';

// Naming (slug validation for query/profile names).
export { SLUG_PATTERN, isSlug } from './naming.js';

// Login profiles (storage-state staleness summary + secure persistence).
export { summarizeProfileState, persistProfileState } from './profiles.js';
export type { ProfileStateSummary } from './profiles.js';

// Persistence (SQLite run store + saved-query replay helpers).
export {
  createRunStore,
  openDatabase,
  resolveDbPath,
  exportRuns,
  buildQueryRunSpec,
  prepareSavedQueryRun,
} from './store/index.js';
export type { RunRow, SavedQueryRow, ProfileRow, ExportRunsOptions } from './store/index.js';

// Run queue (in-process worker pool over the persisted store).
export { createRunQueue } from './runtime/index.js';
export type { ExecuteRunFn, ExecuteRunOutcome } from './runtime/index.js';
