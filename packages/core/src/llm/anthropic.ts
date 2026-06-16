/**
 * Anthropic LLM provider — maps the shared `ChatRequest`/`ChatResponse`
 * contracts onto the Anthropic Messages API via @anthropic-ai/sdk.
 */
import Anthropic from '@anthropic-ai/sdk';
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  LlmProvider,
  ToolCall,
  ToolDefinition,
} from '../contracts.js';

/** Anthropic requires max_tokens; used when the request leaves it unset. */
const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
}

export class AnthropicProvider implements LlmProvider {
  readonly id: string;

  private readonly client: Anthropic;
  private readonly model: string;

  constructor(options: AnthropicProviderOptions) {
    if (!options.apiKey) {
      throw new Error(
        'AnthropicProvider requires an API key. Set the ANTHROPIC_API_KEY environment variable or pass apiKey explicitly.',
      );
    }
    if (!options.model) {
      throw new Error(
        'AnthropicProvider requires a model id. Set the ANTHROPIC_MODEL environment variable or pass model explicitly.',
      );
    }
    this.model = options.model;
    this.id = `anthropic:${options.model}`;
    this.client = new Anthropic({ apiKey: options.apiKey, maxRetries: 3 });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const toolChoice = toAnthropicToolChoice(req.toolChoice);

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: toAnthropicMessages(req.messages),
      ...(req.system === undefined ? {} : { system: req.system }),
      ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
      ...(req.tools !== undefined && req.tools.length > 0
        ? { tools: req.tools.map(toAnthropicTool) }
        : {}),
      ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    });

    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];
    for (const block of response.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id, name: block.name, input: block.input });
      }
    }

    return {
      text: textParts.length > 0 ? textParts.join('\n') : null,
      toolCalls,
      stopReason: toStopReason(response.stop_reason),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}

function toStopReason(stopReason: string | null): ChatResponse['stopReason'] {
  switch (stopReason) {
    case 'end_turn':
      return 'end';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    default:
      return 'other';
  }
}

function toAnthropicTool(tool: ToolDefinition): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    // ToolDefinition.inputSchema is a JSON Schema object; Anthropic's typed
    // shape additionally requires `type: 'object'`, which callers provide.
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
  };
}

function toAnthropicToolChoice(
  toolChoice: ChatRequest['toolChoice'],
): Anthropic.ToolChoice | undefined {
  if (toolChoice === undefined) return undefined;
  if (toolChoice === 'auto') return { type: 'auto' };
  if (toolChoice === 'required') return { type: 'any' };
  return { type: 'tool', name: toolChoice.name };
}

/**
 * Maps contract messages to Anthropic message params.
 *
 * - assistant `toolCalls` become `tool_use` content blocks;
 * - `toolResult` messages become `tool_result` blocks on a user turn;
 * - consecutive same-role turns are merged into one message so the
 *   API's strict user/assistant alternation is always satisfied
 *   (e.g. multiple toolResult messages after a parallel tool call).
 */
function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  const result: Array<{ role: 'user' | 'assistant'; content: Anthropic.ContentBlockParam[] }> = [];

  for (const message of messages) {
    const { role, blocks } = toAnthropicTurn(message);
    const previous = result[result.length - 1];
    if (previous !== undefined && previous.role === role) {
      previous.content.push(...blocks);
    } else {
      result.push({ role, content: blocks });
    }
  }

  return result;
}

function toAnthropicTurn(message: ChatMessage): {
  role: 'user' | 'assistant';
  blocks: Anthropic.ContentBlockParam[];
} {
  if (message.role === 'toolResult') {
    return {
      role: 'user',
      blocks: [
        {
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: message.content,
        },
      ],
    };
  }

  const blocks: Anthropic.ContentBlockParam[] = [];
  if (message.content.length > 0) {
    blocks.push({ type: 'text', text: message.content });
  }
  if (message.role === 'assistant' && 'toolCalls' in message) {
    for (const call of message.toolCalls) {
      blocks.push({
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: call.input ?? {},
      });
    }
  }
  if (blocks.length === 0) {
    throw new Error(
      `Cannot send an empty ${message.role} message to Anthropic: provide non-empty content or tool calls.`,
    );
  }
  return { role: message.role, blocks };
}
