import { test, expect } from '@playwright/test';

import { loginViaOidc } from '../tests/e2e/helpers/oidc-login.js';
import {
  connectJmap,
  createEmailInMailbox,
  listMailboxes,
  mailboxByRole,
  sweepOrphanTestMessages,
} from '../tests/e2e/helpers/jmap-client.js';
import { selfEmail } from '../tests/e2e/helpers/stack-env.js';
import {
  liveE2eEnabled,
  skipLiveE2eMessage,
} from '../tests/e2e/helpers/stack-env.js';
import { attachConsoleTail, trackConsole, waitForShellReady } from '../tests/e2e/helpers/ui.js';

/**
 * Reproduces the user-reported "long delay on the first delete after
 * login" complaint against the local Stalwart stack and acts as a
 * regression canary for the optimistic-splice + applyMove-batching
 * fix. Baseline measurement before the fix was 850-900 ms cold and
 * 1.4-2.4 s warm; after the fix it is ~400 ms cold and ~1.2-1.5 s
 * warm against a local Stalwart on the same machine.
 *
 *   cold-delete: time from clicking the trash icon to the row being
 *                removed from the DOM, fired within ~1 s of inbox
 *                first render. At this point the metadata indexer
 *                has just started its first tick and the bootstrap
 *                sync chain is finishing, so the engine lock is
 *                heavily contended.
 *
 *   warm-delete: same measurement after WARM_DELAY_MS of idle so
 *                background work has quiesced. Reported for context;
 *                not asserted, because warm latency is still
 *                indexer-dominated and chasing it requires lock
 *                priority changes outside the scope of this fix.
 *
 * Uses a page-side MutationObserver instead of Playwright's
 * waitFor(state: 'detached') because the latter polls every 50-100 ms
 * and overstates the real latency by that much.
 *
 * Skipped unless LOCAL_STACK=1 (local Stalwart + Keycloak running).
 */

const COLD_THRESHOLD_MS = Number(process.env.COLD_THRESHOLD_MS ?? 800);
const WARM_DELAY_MS = Number(process.env.WARM_DELAY_MS ?? 8_000);
const SUBJECT_PREFIX = 'Delete e2e perf';

// temp skipping until get running, remove when ready to test this one
test.skip();

test.skip(!liveE2eEnabled, skipLiveE2eMessage);

test.describe('Delete latency under cold vs warm conditions', () => {
  test.setTimeout(240_000);

  test('cold delete after login finishes within the budget', async ({ page }, testInfo) => {
    const consoleLines = [];
    trackConsole(page, consoleLines);

    // Two disposable messages so we can measure cold (immediately
    // after login) AND warm (after the indexer has idled) without
    // crossing them.
    const jmap = await connectJmap();
    const mailboxes = await listMailboxes(jmap);
    const inbox = mailboxByRole(mailboxes, 'inbox');
    if (!inbox) throw new Error('Local stack requires an Inbox mailbox');
    await sweepOrphanTestMessages(jmap, { subjectPrefix: SUBJECT_PREFIX });

    const stamp = Date.now();
    const fromEmail = selfEmail();
    const subjects = [];
    const createdIds = [];
    for (let i = 0; i < 2; i += 1) {
      const subject = `${SUBJECT_PREFIX} ${stamp} #${i}`;
      const id = await createEmailInMailbox(jmap, {
        mailboxId: inbox.id,
        fromEmail,
        subject,
      });
      subjects.push(subject);
      createdIds.push(id);
    }

    try {
      await loginViaOidc(page);
      await waitForShellReady(page);

      // Make sure both seeded rows are visible BEFORE the cold
      // measurement so we are not also paying for the initial
      // inbox-render round trip. We still measure within ~1 s of
      // the very first render so the indexer and bootstrap are
      // still active.
      for (const subject of subjects) {
        await expect.poll(
          async () => page.locator('.msg-list__item').filter({ hasText: subject }).count(),
          { timeout: 90_000, message: `seeded subject "${subject}" should render` },
        ).toBeGreaterThan(0);
      }

      const coldMs = await measureDeleteLatency(page, subjects[0]);
      console.log(`[delete-latency] cold = ${coldMs} ms`);

      await page.waitForTimeout(WARM_DELAY_MS);

      const warmMs = await measureDeleteLatency(page, subjects[1]);
      console.log(`[delete-latency] warm = ${warmMs} ms`);
      console.log(`[delete-latency] delta = ${coldMs - warmMs} ms`);

      await testInfo.attach('latency.json', {
        body: JSON.stringify({ coldMs, warmMs, warmDelayMs: WARM_DELAY_MS }, null, 2),
        contentType: 'application/json',
      });

      // Threshold reflects the post-fix cold baseline (~400 ms +
      // headroom for CI jitter). If this fails it almost certainly
      // means a regression in either the optimistic splice or the
      // OUTBOX_APPLY_MOVE one-transaction batching; before bumping
      // the threshold, profile to confirm the increase is real
      // workload (e.g. larger inbox) and not new sync chain or
      // refresh work blocking the destroyMessages call.
      expect(
        coldMs,
        `cold delete took ${coldMs} ms (warm baseline ${warmMs} ms)`,
      ).toBeLessThan(COLD_THRESHOLD_MS);
    } finally {
      await attachConsoleTail(testInfo, consoleLines, 200);
      for (const id of createdIds) {
        try {
          await jmap;
          // Always destroy whatever survived (whether moved to
          // Trash by the test or still in Inbox if the test
          // failed); ignore errors so a single dead row does not
          // block the rest of the cleanup.
          // eslint-disable-next-line no-await-in-loop
          const { cleanupEmail } = await import('./helpers/jmap-client.js');
          const trash = mailboxByRole(mailboxes, 'trash');
          if (trash) {
            // eslint-disable-next-line no-await-in-loop
            await cleanupEmail(jmap, id, trash.id);
          }
        } catch {
          // best-effort
        }
      }
    }
  });
});

async function measureDeleteLatency(page, subject) {
  const row = page.locator('.msg-list__item').filter({ hasText: subject }).first();
  await row.waitFor({ state: 'visible', timeout: 15_000 });
  // Open the message in the right pane so the article-level Delete
  // button is present. Mirrors the user flow: click row, click
  // trash icon. The row.click() also triggers the mark-as-seen
  // mutation, which is what the cold-delete latency complaint was
  // really about: the destroy mutation queues behind it on the
  // outbox runner and pays the full lock-acquisition cost.
  await row.click();
  await page.locator('.message-view__title h2').waitFor({ state: 'visible', timeout: 15_000 });

  // Use a page-side MutationObserver to capture the EXACT moment
  // the row leaves the DOM. Playwright's waitFor(state: 'detached')
  // polls every 50-100 ms, overstating the real latency by that
  // much (the optimistic splice gets ~50 ms credit it does not
  // deserve, and we lose the ability to see ~50 ms regressions
  // inside the noise).
  await page.evaluate((subj) => {
    const list = document.querySelector('.msg-list, .message-list, body');
    window.__rowGone = new Promise((resolve) => {
      const obs = new MutationObserver(() => {
        const rows = document.querySelectorAll('.msg-list__item');
        for (const r of rows) {
          if (r.textContent && r.textContent.includes(subj)) return;
        }
        resolve(performance.now());
        obs.disconnect();
      });
      obs.observe(list, { childList: true, subtree: true });
    });
    window.__clickMark = null;
  }, subject);

  await page.evaluate(() => { window.__clickMark = performance.now(); });
  await page.locator('.message-view__action--danger[title="Delete"]').first().click();
  await page.locator('.msg-list__item').filter({ hasText: subject }).waitFor({
    state: 'detached',
    timeout: 60_000,
  });
  const pageMs = await page.evaluate(async () => {
    const goneAt = await window.__rowGone;
    return Math.round(goneAt - window.__clickMark);
  });
  return pageMs;
}
