import { test, expect } from '@playwright/test';

/**
 * End-to-end regression for the background metadata indexer.
 *
 * Pins the speedup contract that ships with the new indexer tunables
 * (250ms inter-tick delay, 5 chunks per tick, tier-based chunk size).
 * Before the speedup a 3000-message Archives folder took ~120s to
 * fully index in the worst case (chunk=100, 2.5s tick delay); the
 * new defaults bring that to ~50s against Stalwart on localhost.
 * The 90s budget below is the headroom we want before this test is
 * considered a regression — if it ever creeps past 90s, either the
 * tunables drifted or Stalwart got slower.
 *
 * The flow:
 *   1. Sign in.
 *   2. Pick the largest folder over 1000 messages from the stage
 *      fixture (Archives in the seeded account; falls back to any
 *      folder with total_emails > 1000 if the layout changes).
 *   3. Reset its query_view so the next visit is a "cold" load.
 *   4. Navigate into it (kicks the foreground first page).
 *   5. Wait for queryViewProgress to reach 100% covered.
 *   6. Verify the FolderNode percent badge appeared mid-flight so we
 *      know the user actually saw progress feedback (otherwise the
 *      indexer might have raced to completion without ever rendering
 *      a < 100 percent).
 *
 * Runs against the local Stalwart stage; skipped without credentials.
 */

const STAGE_USERNAME = process.env.STAGE_USERNAME;
const STAGE_PASSWORD = process.env.STAGE_PASSWORD;

test.skip(
  !STAGE_USERNAME || !STAGE_PASSWORD,
  'STAGE_USERNAME / STAGE_PASSWORD not set; live-stage indexer e2e skipped',
);

test.describe('Metadata indexer speed', () => {
  test.setTimeout(120_000);

  test('a >1000-message folder fully indexes within the speedup budget after a cold refresh', async ({ page }, testInfo) => {
    const consoleLines = [];
    page.on('console', (msg) => {
      consoleLines.push(`[${msg.type()}] ${msg.text()}`);
    });

    await login(page);
    await waitForShellReady(page);
    await page.waitForFunction(() => !!window.__repo, { timeout: 30_000 });

    // Pick the largest folder over the speedup threshold. Archives
    // is the canonical pick in the seeded stage account; fall back
    // to any folder that satisfies the size constraint so the test
    // doesn't go red if the seed is reshuffled.
    const target = await page.evaluate(async () => {
      const accounts = await globalThis.__repo.listAccounts();
      const account = accounts[0];
      const folders = await globalThis.__repo.listFolders(account.id);
      const big = folders
        .filter((f) => Number(f.total_emails ?? 0) > 1000 && !f.is_deleted)
        .sort((a, b) => Number(b.total_emails) - Number(a.total_emails));
      const folder = big[0];
      if (!folder) return null;
      return {
        accountId: account.id,
        folderId: folder.id,
        folderName: folder.name,
        total: Number(folder.total_emails),
        role: folder.role,
      };
    });
    test.skip(!target, 'no folder over 1000 messages in this stage fixture');
    // The cast keeps TypeScript-shaped editors happy; the runtime
    // check above already guards.
    const { accountId, folderId, folderName, total, role } = target;
    testInfo.annotations.push({
      type: 'target',
      description: `${folderName} (role=${role ?? '-'}, total=${total})`,
    });

    // Drop the existing query_view so painted ranges go back to
    // empty. The FK cascade clears query_view_items and
    // query_view_ranges; next visit has to refill from position 0.
    await page.evaluate(async ({ accountId, folderId }) => {
      await globalThis.__repo.resetViewForFolder(accountId, folderId);
    }, { accountId, folderId });

    // Sanity: progress is now zero before we navigate.
    const sortProp = role === 'sent' || role === 'drafts' ? 'sent' : 'received';
    const beforeProgress = await page.evaluate(async ({ accountId, folderId, sortProp }) => {
      return globalThis.__repo.queryViewProgress({ accountId, folderId, sort: sortProp });
    }, { accountId, folderId, sortProp });
    expect(beforeProgress.covered).toBe(0);

    // Click into the folder. This is what the user does in practice;
    // it also kicks the foreground first-page load + lets the
    // indexer fill the rest in the background.
    await page.locator('.folder-node').filter({ hasText: folderName }).click();

    // Capture the badge percent over time so we can assert the user
    // sees feedback before the load finishes. Polling every 250ms is
    // matched to the indexer tick delay, so any mid-flight tick
    // should be visible at least once.
    /** @type {Array<{ts:number, percent:number|null}>} */
    const badgeSamples = [];
    let badgePollerActive = true;
    const startMs = Date.now();
    const poller = (async () => {
      while (badgePollerActive) {
        const sample = await page.evaluate((folderName) => {
          const nodes = Array.from(document.querySelectorAll('.folder-node'));
          const node = nodes.find((n) => {
            const name = n.querySelector('.folder-node__name')?.textContent?.trim();
            return name === folderName;
          });
          if (!node) return null;
          const badge = node.querySelector('.folder-node__index');
          if (!badge) return null;
          const m = (badge.textContent ?? '').match(/(\d+)%/);
          return m ? Number(m[1]) : null;
        }, folderName);
        badgeSamples.push({ ts: Date.now() - startMs, percent: sample });
        await new Promise((r) => setTimeout(r, 250));
      }
    })();

    try {
      // Reach 100% covered. The speedup budget is "well inside 30s
      // for a ~3000-message folder"; we give a wide 30s deadline so
      // the test is robust to CI noise without losing teeth (the
      // pre-speedup indexer would have taken 75s+).
      await expect.poll(
        async () => {
          const p = await page.evaluate(async ({ accountId, folderId, sortProp }) => {
            return globalThis.__repo.queryViewProgress({ accountId, folderId, sort: sortProp });
          }, { accountId, folderId, sortProp });
          return p.covered >= p.total && p.total > 0;
        },
        {
          timeout: 90_000,
          message: `expected ${folderName} (${total} msgs) to fully index within 90s`,
        },
      ).toBe(true);
    } finally {
      badgePollerActive = false;
      await poller;
    }

    const finalProgress = await page.evaluate(async ({ accountId, folderId, sortProp }) => {
      return globalThis.__repo.queryViewProgress({ accountId, folderId, sort: sortProp });
    }, { accountId, folderId, sortProp });
    expect(finalProgress.covered).toBeGreaterThanOrEqual(finalProgress.total);

    // The UI should have shown an intermediate percent at least once
    // during the indexing (i.e. the user saw a 1-99% badge). If the
    // indexer ever short-circuits and writes coverage 0 -> 100 in
    // one shot, the user never sees feedback for a long-running
    // load. The badge condition (`> 0 && < 100`) catches this.
    const sawIntermediate = badgeSamples.some(
      (s) => s.percent != null && s.percent > 0 && s.percent < 100,
    );
    if (!sawIntermediate) {
      await testInfo.attach('badge-samples.json', {
        body: JSON.stringify(badgeSamples, null, 2),
        contentType: 'application/json',
      });
      await testInfo.attach('console-tail.txt', {
        body: consoleLines.slice(-200).join('\n'),
        contentType: 'text/plain',
      });
    }
    expect(sawIntermediate, 'folder percent badge never showed an intermediate value').toBe(true);
  });
});

async function login(page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Thundermail' })).toBeVisible();
  await page.getByRole('button', { name: /use app password instead/i }).click();
  await page.getByLabel('Username').fill(STAGE_USERNAME);
  await page.getByLabel('App password').fill(STAGE_PASSWORD);
  await page.getByRole('button', { name: /^sign in$/i }).click();
}

async function waitForShellReady(page) {
  await expect(page.locator('.shell')).toBeVisible({ timeout: 30_000 });
  await expect.poll(
    async () => page.locator('.folder-node').count(),
    { timeout: 30_000, message: 'expected folder tree to render at least one folder' },
  ).toBeGreaterThan(0);
}
