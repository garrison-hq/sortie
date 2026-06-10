/**
 * Playwright E2E configuration for the nanofish playground UI.
 *
 * Runs against the REAL stack: the webServer command builds the whole
 * monorepo, then starts the production server (apps/server/dist) on a
 * dedicated port with an isolated data directory. Tests drive a real
 * chromium against the served UI; the live extract test exercises a real
 * browser worker and a real LLM call, so keep the suite single-worker and
 * in file order (later tests depend on the run created by the live flow).
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const E2E_PORT = 3471;
const E2E_DATA_DIR = '/tmp/nanofish-e2e-data';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export default defineConfig({
  testDir: './e2e',
  // Tests in playground.spec.ts depend on shared state (the live run) and
  // must execute in file order on a single worker.
  fullyParallel: false,
  workers: 1,
  retries: 1,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  // Generous default; the live LLM test raises its own timeout further.
  timeout: 120_000,
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    viewport: { width: 1280, height: 900 },
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      // Re-assert the viewport after the device preset (which is 1280x720):
      // review artifacts are captured at 1280x900.
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
    },
  ],
  webServer: {
    // Fresh production build + clean data dir, then the real server.
    command: `pnpm build && rm -rf ${E2E_DATA_DIR} && node apps/server/dist/index.js`,
    cwd: REPO_ROOT,
    url: `http://localhost:${E2E_PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 300_000,
    env: {
      // Explicit env beats the repo .env loaded by the server at boot.
      NANOFISH_DATA_DIR: E2E_DATA_DIR,
      NANOFISH_PORT: String(E2E_PORT),
    },
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
