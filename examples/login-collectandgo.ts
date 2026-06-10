/**
 * One-time manual login for collectandgo.be (or any CAPTCHA-gated site).
 *
 * Colruyt's anti-bot wall requires a human once; sortie never bypasses
 * CAPTCHAs by design. This opens a headful browser — log in yourself, solve
 * the verification, then press Enter in the terminal. The session (cookies +
 * storage) is saved and any later agent run can reuse it:
 *
 *   npx tsx examples/login-collectandgo.ts
 *   node packages/core/dist/cli.js agent https://www.collectandgo.be \
 *     --goal "..." --storage-state data/sessions/collectandgo.json ...
 */
import { createInterface } from 'node:readline/promises';
import { BrowserManager } from '@garrison-hq/sortie';

const SESSION_PATH = 'data/sessions/collectandgo.json';

const manager = new BrowserManager();
await manager.launch({ headless: false });
const page = await manager.newPage();
await page.goto('https://www.collectandgo.be', { waitUntil: 'domcontentloaded' });

console.log('\nA browser window is open. Log in to Collect&Go (and pass any');
console.log('verification step). When you are fully logged in, return here.\n');

const rl = createInterface({ input: process.stdin, output: process.stdout });
await rl.question('Press Enter once you are logged in... ');
rl.close();

await manager.saveStorageState(page, SESSION_PATH);
await manager.close();
console.log(`Session saved to ${SESSION_PATH} — agent runs can now reuse it via --storage-state.`);
