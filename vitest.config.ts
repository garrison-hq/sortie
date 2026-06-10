/**
 * Root vitest config. The Playwright E2E suite (apps/ui/e2e) matches
 * vitest's default *.spec.ts glob but must only ever run under
 * `pnpm --filter @nanofish/ui e2e` — exclude it here.
 */
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'apps/ui/e2e/**'],
  },
});
