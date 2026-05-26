import { test as base, expect } from '@playwright/test';

import {
  connectJmap,
  ensureArchiveMailbox,
  ensureInboxBaseline,
  listMailboxes,
  mailboxByRole,
  sweepOrphanTestMessages,
} from './jmap-client.js';
import { loginViaOidc } from './oidc-login.js';
import { selfEmail } from './stack-env.js';
import {
  attachConsoleTail,
  clickFolder,
  trackConsole,
  waitForFolderTreeReady,
} from './ui.js';

/**
 * Worker-scoped shared session for "simple" e2e tests.
 *
 * Most tests in this suite create one or two messages, perform a UI
 * action, and assert. They don't need a fresh BrowserContext per
 * test — the OIDC login + SharedWorker boot + OPFS init + first
 * JMAP fetch is ~3-5 s of cold-boot tax that we'd rather pay once
 * per worker, not once per test.
 *
 * This fixture provides:
 *   - `sharedPage`: a worker-scoped Page that's already logged in
 *     and parked on the Inbox folder. Tests use it like the default
 *     `page` fixture but skip the cold boot.
 *   - `consoleTail`: a per-test buffer for console output that gets
 *     reset in beforeEach. Pass to `attachConsoleTail` in finally.
 *
 */

// Subject prefixes the simple specs scatter into the Inbox. We sweep
// them all at the start of each test so accumulated orphans (from
// interrupted previous runs, or just from tests that didn't finish
// their finally{} block) don't pollute the row ordering. Adding a
// prefix here is the recommended way to make a new spec orphan-safe.
//
// IMPORTANT: Stalwart's `subject:` filter is FTS-tokenised, not a
// literal startsWith. A prefix like "Archive e2e" would also match
// any subject that happens to contain both `archive` and `e2e` as
// tokens — including the 1500 "Seed e2e archive N" messages
// seed-mail.mjs creates. So:
//   - Pick distinctive tokens for new prefixes (the spec's own
//     subject prefix is the natural choice).
//   - Do NOT add a prefix that tokenises into a subset of any
//     seed-fixture subject. archive.spec.js for example uses the
//     non-stemmed `ArchiveAction` token to dodge this trap.
const SIMPLE_SPEC_SUBJECT_PREFIXES = [
  'ArchiveAction e2e',
  'Bulk delete e2e',
  'Compose send e2e',
  'Delete e2e',
  'Delete inbox e2e',
  'Keyboard delete e2e',
  'Keyboard delete iframe e2e',
  'Keyboard bulk delete e2e',
  'Keyboard nav e2e',
  'Keyboard reply e2e',
  'Mark unread e2e',
  'Move e2e',
  'iframe-height e2e',
  // Cross-spec orphans that have leaked into Inbox in earlier runs.
  // Cheap to include because the OR'd filter resolves in a single
  // Email/query round trip.
  'Push delivery e2e',
  'Refresh baseline e2e',
  'Ghost refresh e2e',
];

export const test = base.extend({
  // Worker-scoped: created once per Playwright worker, reused for
  // every test in that worker that destructures `sharedPage`.
  sharedPage: [async ({ browser }, use, testInfo) => {
    // Provision the account-level preconditions every simple spec
    // assumes BEFORE the browser opens, so the OPFS first-sync
    // already sees the baseline state. Both helpers are idempotent
    // — no-op once provisioned, ~1 s on a fresh tmpfs Stalwart.
    //
    //   - Archive role mailbox (move/archive specs target it).
    //   - 12 baseline Inbox messages (multi-select / mail-flow /
    //     push-delivery / iframe-height all assume a non-empty
    //     Inbox).
    const jmap = await connectJmap();
    await ensureArchiveMailbox(jmap);
    const mailboxes = await listMailboxes(jmap);
    const inbox = mailboxByRole(mailboxes, 'inbox');
    if (!inbox) throw new Error('Test account has no Inbox mailbox; provision via configure-stalwart');
    await ensureInboxBaseline(jmap, {
      inboxMailboxId: inbox.id,
      fromEmail: selfEmail(),
    });

    const ctx = await browser.newContext({
      storageState: testInfo.project.use?.storageState,
      ignoreHTTPSErrors: true,
    });
    const page = await ctx.newPage();
    // The console buffer lives on the page object so per-test
    // beforeEach can reset it without rewiring listeners.
    const consoleLines = [];
    trackConsole(page, consoleLines);
    page.__consoleLines = consoleLines;
    await loginViaOidc(page);
    await waitForFolderTreeReady(page);
    await use(page);
    await ctx.close();
  }, { scope: 'worker' }],
});

/**
 * Reset the shared page to a known state before a test runs:
 *   1. Sweep accumulated test-mail orphans (one OR'd Email/query).
 *   2. Close any stray compose dialog left by a previous test.
 *   3. Click Inbox to re-anchor the folder selection (no-op if the
 *      previous test left us there, fast in any case because the
 *      folder tree is already loaded).
 *   4. Clear the per-test console buffer.
 *
 * Specs call this from their own `test.beforeEach` so individual
 * tests can layer additional setup (e.g. extra subject prefixes
 * specific to the spec).
 */
export async function resetSharedSession(page, {
  extraSubjectPrefixes = [],
} = {}) {
  const jmap = await connectJmap();
  await sweepOrphanTestMessages(jmap, {
    subjectPrefixes: [...SIMPLE_SPEC_SUBJECT_PREFIXES, ...extraSubjectPrefixes],
  });
  await page.keyboard.press('Escape').catch(() => {});
  const composeOpen = await page.locator('.compose-dialog').count();
  if (composeOpen > 0) {
    await page.getByRole('button', { name: /^discard$/i }).click().catch(() => {});
    await page.locator('.compose-dialog').waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
  }
  await clickFolder(page, 'Inbox');
  if (Array.isArray(page.__consoleLines)) {
    page.__consoleLines.length = 0;
  }
}

/** Convenience: get the per-test console buffer attached to the page. */
export function consoleLinesFor(page) {
  return Array.isArray(page.__consoleLines) ? page.__consoleLines : [];
}

/** Convenience re-export so specs can `import { test, expect } …`. */
export { expect, attachConsoleTail };
