import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from '@playwright/test';

import baseConfig from '../playwright.config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Playwright config for the research/ folder. Same web server, same
 * projects, same global setup as the main config — the only thing
 * that changes is which directory Playwright scans, so the everyday
 * `npx playwright test` invocation does NOT pick these slow / opt-in
 * benchmarks up. Run them explicitly with:
 *
 *   docker exec -u node -w /workspace -e LOCAL_STACK=1 -e PLAYWRIGHT_REUSE=1 \
 *     thundermail-dev npx playwright test \
 *     --config research/playwright.config.js \
 *     [--project=chromium|firefox] \
 *     [-g <pattern>]
 *
 * See research/README.md for what each benchmark does and how to
 * interpret the output.
 */
export default defineConfig({
  ...baseConfig,
  testDir: HERE,
  // globalSetup in the base config is the string './tests/e2e/global-setup.js'
  // which Playwright resolves relative to whichever config file is loaded;
  // re-anchor it to the repo root so it still finds the same file when
  // loaded from research/.
  globalSetup: baseConfig.globalSetup
    ? path.resolve(HERE, '..', baseConfig.globalSetup)
    : undefined,
  // Each benchmark in here can run up to a few minutes against a
  // local stack (vfs-bench is 9 cases x ~9s each per browser); cap
  // generously and let individual tests set their own setTimeout.
  timeout: 300_000,
});
