/**
 * Multi-step agent loop: natural-language goal in -> sequence of browser tool
 * actions -> schema-validated structured output (via the done tool).
 *
 * Each iteration distills the live page, feeds the model the previous
 * observation plus a fresh snapshot, forces a tool call, executes it, and
 * records a StepRecord. Executor errors are surfaced to the model as
 * observations (never run failures) so it can recover.
 *
 * Security invariant: credential VALUES never enter prompts, step records,
 * observations, or messages — the model only sees credential names and
 * "{{cred:NAME}}" placeholders; substitution happens inside executeAction().
 */
import { z } from 'zod';
import type { Page } from 'playwright';
import type {
  AgentRunOptions,
  AgentRunResult,
  ChatMessage,
  PageSnapshot,
  StepRecord,
  TokenUsage,
} from '../contracts.js';
import { createProvider } from '../llm/index.js';
import { BrowserManager, distillPage } from '../browser/index.js';
import { navigateAndSettle } from '../extract/index.js';
import { buildAgentSystemPrompt } from './prompts.js';
import { AGENT_TOOLS, executeAction, type ExecutionContext } from './tools.js';

const DEFAULT_MAX_STEPS = 25;
const DONE_TOOL = 'done';
const FAIL_TOOL = 'fail';

const SNAPSHOT_HEADER = '--- Page snapshot ---';
const SNAPSHOT_MAX_CHARS = 10_000;
const SNAPSHOT_ELIDED = '[earlier page snapshot elided]';
/** How many of the most recent snapshot blocks survive context bounding. */
const RECENT_SNAPSHOTS_KEPT = 2;

/** A step's outcome: keep looping, or terminate the run. */
type StepOutcome<T> =
  | { kind: 'continue' }
  | { kind: 'success'; output: T }
  | { kind: 'failed'; reason: string };

/**
 * Run a multi-step agent toward `opts.goal`, starting at `opts.startUrl`.
 *
 * Reuses `opts.page` when given; otherwise launches a browser (honoring
 * `headless` / `storageStatePath`) and always cleans it up. Terminates on the
 * done tool (status 'success', schema-validated output), the fail tool
 * (status 'failed'), or step-budget exhaustion (status 'max_steps').
 */
export async function runAgent<T>(opts: AgentRunOptions<T>): Promise<AgentRunResult<T>> {
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const provider = opts.provider ?? createProvider();
  const credentials = opts.credentials ?? {};

  const system = buildAgentSystemPrompt({
    goal: opts.goal,
    credentialNames: Object.keys(credentials),
    outputSchemaJson: opts.schema
      ? JSON.stringify(z.toJSONSchema(opts.schema, { io: 'input' }), null, 2)
      : undefined,
    maxSteps,
  });

  let manager: BrowserManager | undefined;
  let page = opts.page;

  try {
    if (!page) {
      manager = new BrowserManager();
      await manager.launch({ headless: opts.headless });
      page = await manager.newPage({ storageStatePath: opts.storageStatePath });
    }
    await navigateAndSettle(page, opts.startUrl);

    const ctx: ExecutionContext = { page, credentials, provider };
    const messages: ChatMessage[] = [];
    const steps: StepRecord[] = [];
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

    // The pending tool call awaiting its toolResult message; absent only on
    // the very first turn (which is sent as a plain user message instead).
    let pendingToolCallId: string | undefined;
    let pendingObservation = '';

    for (let index = 0; index < maxSteps; index++) {
      const startedAt = Date.now();
      const { url, title, snapshotBlock } = await snapshotPage(page);

      if (pendingToolCallId === undefined) {
        messages.push({ role: 'user', content: snapshotBlock });
      } else {
        messages.push({
          role: 'toolResult',
          toolCallId: pendingToolCallId,
          content: `${pendingObservation}\n\n${snapshotBlock}`,
        });
      }

      const response = await provider.chat({
        system,
        // Full history is kept locally; stale snapshot blocks are elided
        // on the wire so context stays bounded on long runs.
        messages: elideStaleSnapshots(messages),
        tools: AGENT_TOOLS,
        toolChoice: 'required',
        maxTokens: 4096,
      });
      usage.inputTokens += response.usage.inputTokens;
      usage.outputTokens += response.usage.outputTokens;

      const call = response.toolCalls[0];
      if (!call) {
        return {
          status: 'failed',
          failureReason:
            `Model returned no tool call despite toolChoice "required" ` +
            `(stopReason: ${response.stopReason}, provider: ${provider.id}).`,
          steps,
          usage,
          finalUrl: page.url(),
        };
      }

      // RAW model input — credentials stay as {{cred:NAME}} placeholders here.
      const input = asRecord(call.input);

      // Only the call we answer goes into history, so every tool_use block
      // sent to the provider gets a matching toolResult.
      messages.push({ role: 'assistant', content: response.text ?? '', toolCalls: [call] });

      const { observation, outcome } = await resolveToolCall(ctx, call.name, input, opts.schema);

      const step: StepRecord = {
        index,
        url,
        title,
        thought: response.text ?? '',
        action: { tool: call.name, input },
        observation,
        startedAt,
        durationMs: Date.now() - startedAt,
      };
      steps.push(step);
      notifyStep(opts.onStep, step);

      if (outcome.kind === 'success') {
        return { status: 'success', output: outcome.output, steps, usage, finalUrl: page.url() };
      }
      if (outcome.kind === 'failed') {
        return {
          status: 'failed',
          failureReason: outcome.reason,
          steps,
          usage,
          finalUrl: page.url(),
        };
      }

      pendingToolCallId = call.id;
      pendingObservation = observation;
    }

    return {
      status: 'max_steps',
      failureReason: `Step budget of ${maxSteps} steps exhausted before the goal was completed.`,
      steps,
      usage,
      finalUrl: page.url(),
    };
  } finally {
    if (manager) {
      await manager.close();
    }
  }
}

/**
 * Resolve a single model tool call into the observation shown back to the
 * model plus the loop `StepOutcome`. The done/fail tools are interpreted here
 * (termination semantics live in the loop, not the executor); every other tool
 * is run through `executeAction`, which never throws by contract.
 */
async function resolveToolCall<T>(
  ctx: ExecutionContext,
  toolName: string,
  input: Record<string, unknown>,
  schema: AgentRunOptions<T>['schema'],
): Promise<{ observation: string; outcome: StepOutcome<T> }> {
  if (toolName === DONE_TOOL) {
    return resolveDone(input, schema);
  }
  if (toolName === FAIL_TOOL) {
    return resolveFail(input);
  }
  // executeAction never throws by contract (errors come back as observation
  // text); the catch is a last-resort safety net.
  const observation = await executeAction(ctx, toolName, input).catch(
    (err: unknown) =>
      `Action "${toolName}" failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  return { observation, outcome: { kind: 'continue' } };
}

function resolveDone<T>(
  input: Record<string, unknown>,
  schema: AgentRunOptions<T>['schema'],
): { observation: string; outcome: StepOutcome<T> } {
  if (!schema) {
    return {
      observation: 'Goal completed; result accepted.',
      outcome: { kind: 'success', output: input['result'] as T },
    };
  }
  const parsed = schema.safeParse(input['result']);
  if (parsed.success) {
    return {
      observation: 'Goal completed; result accepted.',
      outcome: { kind: 'success', output: parsed.data },
    };
  }
  return {
    observation: `Validation failed: ${formatIssues(parsed.error)}. Fix the result and call done again.`,
    outcome: { kind: 'continue' },
  };
}

function resolveFail<T>(input: Record<string, unknown>): {
  observation: string;
  outcome: StepOutcome<T>;
} {
  const rawReason = input['reason'];
  const reason =
    typeof rawReason === 'string' && rawReason.trim().length > 0
      ? rawReason.trim()
      : 'Agent called fail without giving a reason.';
  return { observation: `Run marked as failed: ${reason}`, outcome: { kind: 'failed', reason } };
}

/**
 * Distill the current page into the LLM-facing snapshot block plus the
 * url/title for the StepRecord. Distillation failures (mid-navigation,
 * blocked evaluation, ...) degrade to an explanatory block instead of
 * killing the run, so the model can wait/retry.
 */
async function snapshotPage(
  page: Page,
): Promise<{ url: string; title: string; snapshotBlock: string }> {
  let snapshot: PageSnapshot | undefined;
  let distillError = '';
  try {
    snapshot = await distillPage(page);
  } catch (err) {
    distillError = err instanceof Error ? err.message : String(err);
  }

  if (snapshot) {
    const block = [
      SNAPSHOT_HEADER,
      `URL: ${snapshot.url}`,
      `Title: ${snapshot.title}`,
      'Outline:',
      snapshot.outline,
    ].join('\n');
    return {
      url: snapshot.url,
      title: snapshot.title,
      snapshotBlock: clip(block, SNAPSHOT_MAX_CHARS),
    };
  }

  const url = page.url();
  const title = await page.title().catch(() => '');
  const block = [
    SNAPSHOT_HEADER,
    `URL: ${url}`,
    `Title: ${title}`,
    `Snapshot unavailable: ${distillError}`,
    'The page may still be loading or blocking script evaluation; consider the wait tool or navigating.',
  ].join('\n');
  return { url, title, snapshotBlock: clip(block, SNAPSHOT_MAX_CHARS) };
}

/**
 * Context bounding: return a copy of `messages` where every snapshot block
 * except the most recent `RECENT_SNAPSHOTS_KEPT` is replaced with an elision
 * marker. The text before the block (observations) is preserved, and the
 * original history is never mutated.
 */
function elideStaleSnapshots(messages: ChatMessage[]): ChatMessage[] {
  const snapshotIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.content.includes(SNAPSHOT_HEADER)) {
      snapshotIndices.push(i);
    }
  }
  if (snapshotIndices.length <= RECENT_SNAPSHOTS_KEPT) return messages;

  const stale = new Set(snapshotIndices.slice(0, -RECENT_SNAPSHOTS_KEPT));
  return messages.map((message, i) => {
    if (!stale.has(i)) return message;
    const pos = message.content.indexOf(SNAPSHOT_HEADER);
    return { ...message, content: message.content.slice(0, pos) + SNAPSHOT_ELIDED };
  });
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n...[truncated]` : s;
}

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
}

/** Observer errors must never kill the run. */
function notifyStep(onStep: ((step: StepRecord) => void) | undefined, step: StepRecord): void {
  if (!onStep) return;
  try {
    onStep(step);
  } catch {
    // Swallow: the live view failing is not the agent's problem.
  }
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}
