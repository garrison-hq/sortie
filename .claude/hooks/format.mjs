// PostToolUse hook: prettier-format any file Claude writes/edits.
import { execFileSync } from 'node:child_process';

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;

try {
  const { tool_input: toolInput } = JSON.parse(input);
  const filePath = toolInput?.file_path;
  if (filePath && /\.(ts|tsx|js|jsx|json|css|html|md|yaml|yml)$/.test(filePath)) {
    execFileSync('npx', ['prettier', '--ignore-unknown', '--write', filePath], {
      cwd: process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
      stdio: 'ignore',
      timeout: 15000,
    });
  }
} catch {
  // Never block the edit on a formatting failure.
}
