import { test, expect } from '@playwright/test';

import { loginViaOidc } from '../tests/e2e/helpers/oidc-login.js';
import {
  liveE2eEnabled,
  skipLiveE2eMessage,
} from '../tests/e2e/helpers/stack-env.js';
import {
  attachConsoleTail,
  trackConsole,
  waitForShellReady,
} from '../tests/e2e/helpers/ui.js';

/**
 * End-to-end regression for the background metadata indexer.
 * Uses the Archive folder seeded by tests/fixtures/seed-mail.mjs (≥1500 msgs).
 */

// temp skipping until get running, remove when ready to test this one
test.skip();

test.skip(!liveE2eEnabled, skipLiveE2eMessage);

test.describe('Metadata indexer speed', () => {
  test.setTimeout(120_000);

  test('a >1000-message folder fully indexes within the speedup budget after a cold refresh', async ({ page }, testInfo) => {
    const consoleLines = [];
    trackConsole(page, consoleLines);

    await loginViaOidc(page);
    await waitForShellReady(page);
    await page.waitForFunction(() => !!window.__repo, { timeout: 30_000 });

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
    test.skip(!target, 'no folder over 1000 messages — run npm run stack:seed first');
    const { accountId, folderId, folderName, total, role } = target;
    testInfo.annotations.push({
      type: 'target',
      description: `${folderName} (role=${role ?? '-'}, total=${total})`,
    });

    await page.evaluate(async ({ accountId, folderId }) => {
      await globalThis.__repo.resetViewForFolder(accountId, folderId);
    }, { accountId, folderId });

    const sortProp = role === 'sent' || role === 'drafts' ? 'sent' : 'received';
    const beforeProgress = await page.evaluate(async ({ accountId, folderId, sortProp }) => {
      return globalThis.__repo.queryViewProgress({ accountId, folderId, sort: sortProp });
    }, { accountId, folderId, sortProp });
    expect(beforeProgress.covered).toBe(0);

    await page.locator('.folder-node').filter({ hasText: folderName }).click();

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

    const sawIntermediate = badgeSamples.some(
      (s) => s.percent != null && s.percent > 0 && s.percent < 100,
    );
    if (!sawIntermediate) {
      await testInfo.attach('badge-samples.json', {
        body: JSON.stringify(badgeSamples, null, 2),
        contentType: 'application/json',
      });
      await attachConsoleTail(testInfo, consoleLines);
    }
    expect(sawIntermediate, 'folder percent badge never showed an intermediate value').toBe(true);
  });
});
