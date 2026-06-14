// PostToolUse hook: auto-fix then format any file Claude writes/edits.
//
//  1. `eslint --fix` applies the project's lint rules — including the SonarJS +
//     unicorn rules that mirror the SonarCloud quality profile — so mechanical
//     smells (negated conditions, replaceAll, redundant casts, …) never
//     re-accumulate between full `pnpm lint` runs.
//  2. `prettier` normalizes the final formatting (run last so it wins).
//
// Both steps are best-effort and never block the edit on failure.
import { execFileSync } from 'node:child_process';

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;

const run = (cmd, args, cwd) => {
  try {
    execFileSync(cmd, args, { cwd, stdio: 'ignore', timeout: 20000 });
  } catch {
    // Never block the edit: non-fixable lint errors are surfaced by `pnpm
    // lint`, not here, and a formatter hiccup must not fail the write.
  }
};

try {
  const { tool_input: toolInput } = JSON.parse(input);
  const filePath = toolInput?.file_path;
  const cwd = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  if (filePath && /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath)) {
    run('npx', ['eslint', '--fix', '--no-warn-ignored', filePath], cwd);
  }
  if (filePath && /\.(ts|tsx|js|jsx|json|css|html|md|yaml|yml)$/.test(filePath)) {
    run('npx', ['prettier', '--ignore-unknown', '--write', filePath], cwd);
  }
} catch {
  // Never block the edit.
}
