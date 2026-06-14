/**
 * OpenAI-compatible LLM provider — maps the shared `ChatRequest`/`ChatResponse`
 * contracts onto the Chat Completions API via the openai package.
 *
 * Uses chat.completions (not the Responses API) for maximum compatibility with
 * OpenAI-compatible endpoints such as Ollama, vLLM, and OpenRouter — set
 * `baseUrl` to point at any of them.
 */
import OpenAI from 'openai';
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  LlmProvider,
  ToolCall,
  ToolDefinition,
} from '../contracts.js';

/** The stock OpenAI endpoint; a different baseUrl marks a custom deployment. */
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

export interface OpenAiProviderOptions {
  apiKey: string;
  model: string;
  /** OpenAI-compatible endpoint override (Ollama, vLLM, OpenRouter, ...). */
  baseUrl?: string;
}

export class OpenAiProvider implements LlmProvider {
  readonly id: string;

  private readonly client: OpenAI;
  private readonly model: string;

  constructor(options: OpenAiProviderOptions) {
    if (!options.apiKey) {
      throw new Error(
        'OpenAiProvider requires an API key. Set the OPENAI_API_KEY environment variable, or pass "local" when targeting a local OpenAI-compatible endpoint that does not check keys.',
      );
    }
    if (!options.model) {
      throw new Error(
        'OpenAiProvider requires a model id. Set the OPENAI_MODEL environment variable or pass model explicitly.',
      );
    }
    const baseUrl = options.baseUrl ?? DEFAULT_OPENAI_BASE_URL;
    this.model = options.model;
    this.id =
      baseUrl === DEFAULT_OPENAI_BASE_URL
        ? `openai:${options.model}`
        : `openai:${options.model}@${baseUrl}`;
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: baseUrl,
      maxRetries: 3,
    });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const toolChoice = toOpenAiToolChoice(req.toolChoice);

    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages: toOpenAiMessages(req),
      ...(req.tools !== undefined && req.tools.length > 0
        ? { tools: req.tools.map(toOpenAiTool) }
        : {}),
      ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
      ...(req.maxTokens === undefined ? {} : { max_tokens: req.maxTokens }),
      ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
    });

    const choice = completion.choices[0];
    if (choice === undefined) {
      throw new Error(
        `OpenAI-compatible endpoint returned no choices for model "${this.model}" (provider ${this.id}).`,
      );
    }

    const toolCalls: ToolCall[] = [];
    for (const call of choice.message.tool_calls ?? []) {
      if (call.type !== 'function') continue;
      toolCalls.push({
        id: call.id,
        name: call.function.name,
        input: parseToolArguments(call.function.name, call.function.arguments),
      });
    }

    const content = choice.message.content;

    return {
      text: content !== null && content !== undefined && content.length > 0 ? content : null,
      toolCalls,
      stopReason: toStopReason(choice.finish_reason, toolCalls.length > 0),
      usage: {
        inputTokens: completion.usage?.prompt_tokens ?? 0,
        outputTokens: completion.usage?.completion_tokens ?? 0,
      },
    };
  }
}

function toStopReason(
  finishReason: string | null,
  hasToolCalls: boolean,
): ChatResponse['stopReason'] {
  // Some OpenAI-compatible servers report 'stop' even when tool calls are
  // present; the presence of tool calls is the authoritative signal.
  if (finishReason === 'tool_calls' || hasToolCalls) return 'tool_use';
  switch (finishReason) {
    case 'stop':
      return 'end';
    case 'length':
      return 'max_tokens';
    default:
      return 'other';
  }
}

function toOpenAiTool(tool: ToolDefinition): OpenAI.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function toOpenAiToolChoice(
  toolChoice: ChatRequest['toolChoice'],
): OpenAI.ChatCompletionToolChoiceOption | undefined {
  if (toolChoice === undefined) return undefined;
  if (toolChoice === 'auto') return 'auto';
  if (toolChoice === 'required') return 'required';
  return { type: 'function', function: { name: toolChoice.name } };
}

function toOpenAiMessages(req: ChatRequest): OpenAI.ChatCompletionMessageParam[] {
  const result: OpenAI.ChatCompletionMessageParam[] = [];
  if (req.system !== undefined && req.system.length > 0) {
    result.push({ role: 'system', content: req.system });
  }
  for (const message of req.messages) {
    result.push(toOpenAiMessage(message));
  }
  return result;
}

function toOpenAiMessage(message: ChatMessage): OpenAI.ChatCompletionMessageParam {
  if (message.role === 'toolResult') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }
  if (message.role === 'assistant') {
    if ('toolCalls' in message && message.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: message.content.length > 0 ? message.content : null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: {
            name: call.name,
            arguments: JSON.stringify(call.input ?? {}),
          },
        })),
      };
    }
    return { role: 'assistant', content: message.content };
  }
  return { role: 'user', content: message.content };
}

/**
 * Parses a function call's JSON arguments. Models occasionally emit invalid
 * JSON; surface that as a descriptive error instead of crashing downstream.
 */
function parseToolArguments(toolName: string, rawArguments: string): unknown {
  const trimmed = rawArguments.trim();
  if (trimmed.length === 0) return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `Model returned invalid JSON arguments for tool "${toolName}": ${reason}. Raw arguments: ${rawArguments}`,
      { cause },
    );
  }
}
