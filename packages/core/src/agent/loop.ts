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
 *
 * WP03 — Challenge detection + pause/resume:
 * After each page distillation (snapshotPage), and before composing the LLM
 * message, detectChallengeOnPage() is called.
 *   - assist ON  → pause at the challenged step (awaiting_human); await the
 *                  resume signal from opts.onAwaitingHuman; re-detect on the
 *                  SAME live page; continue if clear, or return awaiting_human
 *                  again if still blocked (no page rebuild, session preserved).
 *   - assist OFF → detection is a deliberate no-op. Today's exact behaviour is
 *                  preserved: the model eventually calls `fail` when it cannot
 *                  proceed past a challenge wall. No new fail path is added
 *                  (spec: T012, C-001).
 */
import { z } from 'zod';
import type { Page } from 'playwright';
import type {
  AgentRunOptions,
  AgentRunResult,
  AssistState,
  ChatMessage,
  LlmProvider,
  PageSnapshot,
  StepOutcome,
  StepRecord,
  TokenUsage,
} from '../contracts.js';
import { createProvider } from '../llm/index.js';
import { BrowserManager, distillPage, humanizedDelay } from '../browser/index.js';
import { navigateAndSettle } from '../extract/index.js';
import { buildAgentSystemPrompt } from './prompts.js';
import { AGENT_TOOLS, executeAction, type ExecutionContext } from './tools.js';
import { detectChallengeOnPage } from '../challenge/detect.js';

const DEFAULT_MAX_STEPS = 25;
const DONE_TOOL = 'done';
const FAIL_TOOL = 'fail';

const SNAPSHOT_HEADER = '--- Page snapshot ---';
const SNAPSHOT_MAX_CHARS = 10_000;
const SNAPSHOT_ELIDED = '[earlier page snapshot elided]';
/** How many of the most recent snapshot blocks survive context bounding. */
const RECENT_SNAPSHOTS_KEPT = 2;

/** Shared mutable state threaded through each loop iteration. */
interface LoopState<T> {
  messages: ChatMessage[];
  steps: StepRecord[];
  usage: TokenUsage;
  pendingToolCallId: string | undefined;
  pendingObservation: string;
  system: string;
  ctx: ExecutionContext;
  /** Lazy getter: provider is only resolved on the first chat() call, after
   *  any challenge-detection pause, so assist runs can pause without a key. */
  getProvider: () => LlmProvider;
  assistEnabled: boolean;
  opts: AgentRunOptions<T>;
}

/**
 * Run a multi-step agent toward `opts.goal`, starting at `opts.startUrl`.
 *
 * Reuses `opts.page` when given; otherwise launches a browser (honoring
 * `headless` / `storageStatePath`) and always cleans it up. Terminates on the
 * done tool (status 'success', schema-validated output), the fail tool
 * (status 'failed'), or step-budget exhaustion (status 'max_steps').
 *
 * When `opts.assistEnabled` is true, challenge detection runs after every
 * distillation. On detection the loop pauses (status 'awaiting_human'), calls
 * `opts.onAwaitingHuman` (if provided) and waits for that promise to resolve
 * before re-detecting and continuing — all on the same live page.
 */
export async function runAgent<T>(opts: AgentRunOptions<T>): Promise<AgentRunResult<T>> {
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const credentials = opts.credentials ?? {};
  const assistEnabled = opts.assistEnabled ?? false;

  // Lazy provider: resolved only on the first chat() call (after any
  // challenge-detection pause). Assist runs that pause at step 0 never
  // trigger provider construction, so no API key is required for them.
  let resolvedProvider: LlmProvider | undefined;
  const getProvider = (): LlmProvider => {
    if (!resolvedProvider) {
      resolvedProvider = opts.provider ?? createProvider();
    }
    return resolvedProvider;
  };

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

    // ExecutionContext.provider is a lazy getter: it is only resolved on the
    // first tool call (extract/search), which only occurs after the challenge
    // detection pause has had its chance to yield awaiting_human.
    const ctx = {
      page,
      credentials,
      get provider(): LlmProvider {
        return getProvider();
      },
    } satisfies ExecutionContext;

    const state: LoopState<T> = {
      messages: [],
      steps: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      pendingToolCallId: undefined,
      pendingObservation: '',
      system,
      ctx,
      getProvider,
      assistEnabled,
      opts,
    };

    for (let index = 0; index < maxSteps; index++) {
      const stepResult = await runStep(page, index, state);
      if (stepResult) return stepResult;
    }

    return {
      status: 'max_steps',
      failureReason: `Step budget of ${maxSteps} steps exhausted before the goal was completed.`,
      steps: state.steps,
      usage: state.usage,
      finalUrl: page.url(),
    };
  } finally {
    if (manager) {
      await manager.close();
    }
  }
}

/**
 * Execute one iteration of the agent loop. Returns a terminal `AgentRunResult`
 * when the run is done (success / failed / awaiting_human), or `null` to
 * continue to the next step.
 */
async function runStep<T>(
  page: Page,
  index: number,
  state: LoopState<T>,
): Promise<AgentRunResult<T> | null> {
  const startedAt = Date.now();
  const { url, title, snapshotBlock, snapshot } = await snapshotPage(page);

  // T012 — Post-distill challenge check (WP03).
  // assist OFF: detection is a deliberate no-op — preserve today's exact
  // behaviour. No new fail path is introduced (spec: T012, C-001).
  if (state.assistEnabled && snapshot) {
    const pauseResult = await handleChallengeStep(page, snapshot, index, startedAt, state);
    if (pauseResult) return pauseResult;
  }

  appendSnapshotMessage(state, snapshotBlock);

  // Apply humanized pacing between actions when assist is on (T013).
  if (state.assistEnabled && index > 0) {
    await humanizedDelay();
  }

  const provider = state.getProvider();
  const response = await provider.chat({
    system: state.system,
    // Full history is kept locally; stale snapshot blocks are elided
    // on the wire so context stays bounded on long runs.
    messages: elideStaleSnapshots(state.messages),
    tools: AGENT_TOOLS,
    toolChoice: 'required',
    maxTokens: 4096,
  });
  state.usage.inputTokens += response.usage.inputTokens;
  state.usage.outputTokens += response.usage.outputTokens;

  const call = response.toolCalls[0];
  if (!call) {
    return {
      status: 'failed',
      failureReason:
        `Model returned no tool call despite toolChoice "required" ` +
        `(stopReason: ${response.stopReason}, provider: ${provider.id}).`,
      steps: state.steps,
      usage: state.usage,
      finalUrl: page.url(),
    };
  }

  // RAW model input — credentials stay as {{cred:NAME}} placeholders here.
  const input = asRecord(call.input);

  // Only the call we answer goes into history, so every tool_use block
  // sent to the provider gets a matching toolResult.
  state.messages.push({ role: 'assistant', content: response.text ?? '', toolCalls: [call] });

  const { observation, outcome } = await resolveToolCall(
    state.ctx,
    call.name,
    input,
    state.opts.schema,
  );

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
  state.steps.push(step);
  notifyStep(state.opts.onStep, step);

  if (outcome.kind === 'success') {
    return {
      status: 'success',
      output: outcome.output,
      steps: state.steps,
      usage: state.usage,
      finalUrl: page.url(),
    };
  }
  if (outcome.kind === 'failed') {
    return {
      status: 'failed',
      failureReason: outcome.reason,
      steps: state.steps,
      usage: state.usage,
      finalUrl: page.url(),
    };
  }

  state.pendingToolCallId = call.id;
  state.pendingObservation = observation;
  return null;
}

/** Append the current snapshot to the message history. */
function appendSnapshotMessage<T>(state: LoopState<T>, snapshotBlock: string): void {
  if (state.pendingToolCallId === undefined) {
    state.messages.push({ role: 'user', content: snapshotBlock });
  } else {
    state.messages.push({
      role: 'toolResult',
      toolCallId: state.pendingToolCallId,
      content: `${state.pendingObservation}\n\n${snapshotBlock}`,
    });
  }
}

/**
 * T012/T013 — Post-distill challenge handler (WP03).
 *
 * Called only when `assistEnabled` is true and distillation succeeded.
 * Runs detection, notifies the caller (queue/WP04) via `onAwaitingHuman`, awaits
 * the resume signal, then re-detects on the SAME live page (no rebuild).
 *
 * Returns a terminal `AgentRunResult` when the challenge is still present after
 * the human's attempt, so `runStep` can surface `awaiting_human` immediately.
 * Returns `null` when the challenge is gone — the caller continues to the LLM step.
 *
 * The page is NEVER rebuilt here — session state (cookies, DOM) is fully
 * preserved so the human's solve carries through to the subsequent navigation.
 */
async function handleChallengeStep<T>(
  page: Page,
  snapshot: PageSnapshot,
  index: number,
  startedAt: number,
  state: LoopState<T>,
): Promise<AgentRunResult<T> | null> {
  const detection = await detectChallengeOnPage(page, snapshot);
  if (!detection?.detected) return null;

  // Notify caller (queue side: WP04). Awaiting this promise IS the resume
  // mechanism — the queue resolves it when the human signals done or times out.
  if (state.opts.onAwaitingHuman) {
    await state.opts.onAwaitingHuman(detection, index);
  }

  // Re-detect once after the human signals done — the challenge may have
  // cleared (T013). Re-distill for fresh title/text; fall back to stale
  // snapshot on distill error so detection still runs. Guard the recheck
  // call the same way: if the page is closed (e.g. timeout closed the context
  // before the hook returned) treat it as "still blocked" so the loop surfaces
  // awaiting_human cleanly rather than throwing into runItem's catch and
  // causing a re-queue of an already-finalized run.
  const recheckSnapshot = await distillPage(page).catch(() => snapshot);
  const recheck = await detectChallengeOnPage(page, recheckSnapshot).catch(() => detection);

  if (recheck?.detected) {
    // Still blocked — surface awaiting_human; WP04 handles timeout/cancel.
    const assist: AssistState = {
      family: recheck.family,
      signal: recheck.signal,
      stepIndex: index,
      challengeUrl: page.url(),
      pausedAt: startedAt,
      deadlineAt: startedAt,
    };
    return {
      status: 'awaiting_human',
      assist,
      steps: state.steps,
      usage: state.usage,
      finalUrl: page.url(),
    };
  }

  // Challenge cleared — apply humanized pacing before the LLM call (T013).
  await humanizedDelay();
  return null;
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
 *
 * Returns the raw `snapshot` object too (needed by the challenge detector).
 */
async function snapshotPage(page: Page): Promise<{
  url: string;
  title: string;
  snapshotBlock: string;
  snapshot: PageSnapshot | undefined;
}> {
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
      snapshot,
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
  return { url, title, snapshotBlock: clip(block, SNAPSHOT_MAX_CHARS), snapshot: undefined };
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
