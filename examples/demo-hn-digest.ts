/**
 * Demo: multi-step AGENT loop on a real site — a Hacker News digest.
 *
 * The agent starts on https://news.ycombinator.com, reads the front page,
 * follows the "More" link to page 2, and returns the 12 highest-scoring
 * stories across both pages as schema-validated JSON.
 *
 * Run from the repo root (needs the provider key in .env):
 *   npx tsx examples/demo-hn-digest.ts
 *
 * Output:
 *   - a compact digest table on stdout
 *   - the full result (stories + run metadata) at /tmp/nanofish-hn-digest.json
 *
 * Etiquette: Hacker News tolerates polite, rate-limited reading. This demo
 * loads exactly two pages in a single run — keep it that way.
 */
import { writeFileSync } from 'node:fs';
// Import the built package directly (the repo root is not a workspace consumer
// of @nanofish/core, so the bare specifier is not resolvable from examples/).
import { createProvider, runAgent, jsonSchemaToZod } from '../packages/core/dist/index.js';
import type { StepRecord } from '../packages/core/dist/index.js';

const START_URL = 'https://news.ycombinator.com';
const OUT_PATH = '/tmp/nanofish-hn-digest.json';
const STORY_COUNT = 12;

// The output contract as plain JSON Schema (what a CLI/API caller would send),
// converted to zod via the same helper the runtime uses.
const DIGEST_JSON_SCHEMA = {
  type: 'object',
  properties: {
    stories: {
      type: 'array',
      description: `Exactly ${STORY_COUNT} stories, ranked 1..${STORY_COUNT} by points (descending).`,
      items: {
        type: 'object',
        properties: {
          rank: { type: 'number', description: '1-based rank within this digest' },
          title: { type: 'string' },
          url: { type: 'string', description: 'the story link (external or item page)' },
          points: { type: 'number' },
          comments: { type: 'number', description: 'comment count; 0 if none shown' },
        },
        required: ['rank', 'title', 'url', 'points', 'comments'],
      },
    },
  },
  required: ['stories'],
} as const;

const GOAL = [
  `Build a Hacker News digest of the top ${STORY_COUNT} stories across the first two pages.`,
  'You start on the front page. Read its stories, then click the "More" link at the',
  'bottom to load page 2 and read those stories as well (two pages total — do not go further).',
  `From all stories seen, pick the ${STORY_COUNT} with the highest point counts and return them`,
  `ranked 1..${STORY_COUNT} by points, descending. Skip job ads (rows without a point count)`,
  'rather than failing on them. For each story report its title, the story URL, its points,',
  'and its comment count (use 0 when no comment count is shown, e.g. some Ask HN or new posts).',
].join(' ');

interface Story {
  rank: number;
  title: string;
  url: string;
  points: number;
  comments: number;
}

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function loadDotEnv(): void {
  try {
    process.loadEnvFile(new URL('../.env', import.meta.url).pathname);
  } catch {
    // .env missing — rely on the ambient environment.
  }
}

function isStory(value: unknown): value is Story {
  if (value === null || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s['rank'] === 'number' &&
    typeof s['title'] === 'string' &&
    typeof s['url'] === 'string' &&
    typeof s['points'] === 'number' &&
    typeof s['comments'] === 'number'
  );
}

function printDigestTable(stories: Story[]): void {
  const title = (s: Story): string => (s.title.length > 58 ? `${s.title.slice(0, 57)}…` : s.title);
  const width = Math.max(...stories.map((s) => title(s).length), 'TITLE'.length);
  console.log(
    `\n${'#'.padStart(2)}  ${'TITLE'.padEnd(width)}  ${'PTS'.padStart(4)}  ${'CMTS'.padStart(4)}`,
  );
  for (const s of stories) {
    console.log(
      `${String(s.rank).padStart(2)}  ${title(s).padEnd(width)}  ${String(s.points).padStart(4)}  ${String(s.comments).padStart(4)}`,
    );
  }
  console.log('');
}

async function main(): Promise<void> {
  loadDotEnv();
  const provider = createProvider();
  console.log(`Provider: ${provider.id}`);
  console.log(`Goal: ${GOAL}\n`);

  const result = await runAgent({
    goal: GOAL,
    startUrl: START_URL,
    schema: jsonSchemaToZod(DIGEST_JSON_SCHEMA as unknown as Record<string, unknown>),
    provider,
    maxSteps: 15,
    headless: true,
    onStep: (step: StepRecord) => {
      console.log(
        `  step ${step.index}: ${step.action.tool} (${step.durationMs}ms) — ${step.observation.slice(0, 100).replaceAll('\n', ' ')}`,
      );
    },
  });

  check(
    'agent run status is success',
    result.status === 'success',
    result.failureReason ?? result.status,
  );
  check('finished within 15 steps', result.steps.length <= 15, `${result.steps.length} steps`);
  check(
    'agent visited page 2 (news?p=2 via More)',
    result.steps.some((s) => s.url.includes('p=2') || s.observation.includes('p=2')),
  );

  const output = (result.output ?? {}) as { stories?: unknown };
  const rawStories = Array.isArray(output.stories) ? output.stories : [];
  const stories = rawStories.filter(isStory);

  check(
    `output has exactly ${STORY_COUNT} well-formed stories`,
    stories.length === STORY_COUNT,
    `${stories.length}`,
  );
  check(
    `ranks are exactly 1..${STORY_COUNT}`,
    stories.map((s) => s.rank).join(',') ===
      Array.from({ length: STORY_COUNT }, (_, i) => i + 1).join(','),
    stories.map((s) => s.rank).join(','),
  );
  check(
    'every story has a non-empty title',
    stories.every((s) => s.title.trim().length > 0),
  );
  check(
    'every story has a non-empty url',
    stories.every((s) => s.url.trim().length > 0),
  );
  check(
    'points and comments are finite non-negative numbers',
    stories.every(
      (s) =>
        Number.isFinite(s.points) &&
        s.points >= 0 &&
        Number.isFinite(s.comments) &&
        s.comments >= 0,
    ),
  );

  if (stories.length > 0) printDigestTable(stories);

  writeFileSync(
    OUT_PATH,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        startUrl: START_URL,
        status: result.status,
        finalUrl: result.finalUrl,
        stepCount: result.steps.length,
        usage: result.usage,
        stories,
        steps: result.steps.map(({ index, url, action, observation, durationMs }) => ({
          index,
          url,
          tool: action.tool,
          observation,
          durationMs,
        })),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Full result written to ${OUT_PATH}`);
  console.log(`Tokens: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out`);

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error('demo-hn-digest failed:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
