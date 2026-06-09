/**
 * Prompts for the multi-step agent loop.
 */

export interface AgentSystemPromptOptions {
  goal: string;
  /** Names only — credential VALUES must never reach a prompt. */
  credentialNames: string[];
  /** JSON Schema (stringified) the done tool's result must match, if any. */
  outputSchemaJson?: string;
  maxSteps: number;
}

/**
 * Build the system prompt for an agent run. Receives credential NAMES only;
 * raw credential values must never be passed in.
 */
export function buildAgentSystemPrompt(opts: AgentSystemPromptOptions): string {
  const parts: string[] = [
    'You are an autonomous web agent driving a real browser through tools.',
    '',
    'Goal:',
    opts.goal.trim(),
    '',
    'How you work:',
    '- Each turn you receive a snapshot of the current page: its URL, title, and an outline of interactive elements. Lines starting with a ref like [e12] identify elements; pass those refs to the click/type/select tools to act on them.',
    '- Work step by step toward the goal: observe the latest snapshot, decide the single best next action, and call exactly one tool.',
    '- Element refs go STALE after any navigation or DOM change. Only ever use refs from the LATEST snapshot; never reuse a ref from an earlier snapshot.',
    '- If an action fails, read the error in the observation, re-examine the fresh snapshot, and try a different approach instead of repeating the same action.',
    '',
    'Credentials:',
  ];

  if (opts.credentialNames.length > 0) {
    parts.push(
      `- Named credentials available for this run: ${opts.credentialNames.join(', ')}.`,
      '- To enter a secret into a field, type the literal placeholder {{cred:NAME}} (e.g. ' +
        `{{cred:${opts.credentialNames[0]}}}` +
        '); the executor substitutes the real value. You never see real credential values — never ask for them and never invent them.',
    );
  } else {
    parts.push(
      '- No credentials are available for this run. Never ask the user for credential values and never invent them.',
    );
  }

  parts.push('', 'Finishing:');

  if (opts.outputSchemaJson) {
    parts.push(
      '- When the goal is fully achieved, call the done tool with a result that matches this JSON Schema exactly:',
      opts.outputSchemaJson,
    );
  } else {
    parts.push(
      '- When the goal is fully achieved, call the done tool with a result summarizing the outcome.',
    );
  }

  parts.push(
    '- If you are genuinely stuck, or the page presents a CAPTCHA or other anti-bot wall, call the fail tool with a clear reason. Never attempt to bypass CAPTCHAs or anti-bot protections.',
    '- Never invent data that is not present on the page; report only what you actually observed.',
    `- You have a hard budget of ${opts.maxSteps} steps. Be economical: avoid redundant actions and finish well within the budget.`,
  );

  return parts.join('\n');
}
