/**
 * LLM provider layer — Anthropic + OpenAI-compatible providers behind the
 * shared `LlmProvider` contract, plus env-driven provider construction.
 */
import type { LlmProvider, ProviderConfig } from '../contracts.js';
import { AnthropicProvider } from './anthropic.js';
import { DEFAULT_OPENAI_BASE_URL, OpenAiProvider } from './openai.js';

export { AnthropicProvider, type AnthropicProviderOptions } from './anthropic.js';
export { DEFAULT_OPENAI_BASE_URL, OpenAiProvider, type OpenAiProviderOptions } from './openai.js';
export type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  LlmProvider,
  ProviderConfig,
  TokenUsage,
  ToolCall,
  ToolDefinition,
} from '../contracts.js';

const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const DEFAULT_OPENAI_MODEL = 'gpt-4o';

/**
 * Creates an `LlmProvider` from explicit config merged over environment
 * defaults. Explicit `cfg` values always win.
 *
 * Environment variables:
 * - `NANOFISH_PROVIDER` — 'anthropic' (default) or 'openai'
 * - `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (default 'claude-sonnet-4-6')
 * - `OPENAI_API_KEY`, `OPENAI_MODEL` (default 'gpt-4o'),
 *   `OPENAI_BASE_URL` (default 'https://api.openai.com/v1')
 *
 * The OpenAI API key may be omitted when a non-default base URL is set —
 * local endpoints like Ollama don't check keys, so 'local' is used instead.
 */
export function createProvider(cfg: Partial<ProviderConfig> = {}): LlmProvider {
  const provider = cfg.provider ?? providerFromEnv();

  if (provider === 'anthropic') {
    const apiKey = cfg.apiKey ?? readEnv('ANTHROPIC_API_KEY');
    if (apiKey === undefined) {
      throw new Error(
        'Missing Anthropic API key: set the ANTHROPIC_API_KEY environment variable, or pass apiKey in the provider config.',
      );
    }
    const model = cfg.model ?? readEnv('ANTHROPIC_MODEL') ?? DEFAULT_ANTHROPIC_MODEL;
    return new AnthropicProvider({ apiKey, model });
  }

  if (provider === 'openai') {
    const baseUrl = cfg.baseUrl ?? readEnv('OPENAI_BASE_URL') ?? DEFAULT_OPENAI_BASE_URL;
    const model = cfg.model ?? readEnv('OPENAI_MODEL') ?? DEFAULT_OPENAI_MODEL;
    let apiKey = cfg.apiKey ?? readEnv('OPENAI_API_KEY');
    if (apiKey === undefined) {
      if (baseUrl !== DEFAULT_OPENAI_BASE_URL) {
        // Local/self-hosted OpenAI-compatible endpoints (Ollama, vLLM, ...)
        // don't require a real key, but the SDK requires a non-empty value.
        apiKey = 'local';
      } else {
        throw new Error(
          'Missing OpenAI API key: set the OPENAI_API_KEY environment variable, or pass apiKey in the provider config. ' +
            '(When targeting a local OpenAI-compatible endpoint such as Ollama or vLLM, set OPENAI_BASE_URL instead — no key is required then.)',
        );
      }
    }
    return new OpenAiProvider({ apiKey, model, baseUrl });
  }

  throw new Error(`Unknown LLM provider "${String(provider)}": expected "anthropic" or "openai".`);
}

function providerFromEnv(): ProviderConfig['provider'] {
  const raw = readEnv('NANOFISH_PROVIDER');
  if (raw === undefined) return 'anthropic';
  const normalized = raw.toLowerCase();
  if (normalized === 'anthropic' || normalized === 'openai') return normalized;
  throw new Error(`Invalid NANOFISH_PROVIDER value "${raw}": expected "anthropic" or "openai".`);
}

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
