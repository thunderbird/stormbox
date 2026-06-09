import { test, expect } from '@playwright/test';

import { loginViaOidc } from './helpers/oidc-login.js';
import {
  liveE2eEnabled,
  skipLiveE2eMessage,
} from './helpers/stack-env.js';
import {
  attachConsoleTail,
  trackConsole,
  waitForFolderTreeReady,
} from './helpers/ui.js';

/**
 * Reproduces the user-reported regression where Inbox fails to load
 * with "[mail-store] ensureLoaded failed" after a sign out followed
 * by a fresh sign in.
 */

// temp skipping until get running, remove when ready to test this one
test.skip();

test.skip(!liveE2eEnabled, skipLiveE2eMessage);

test.describe('Sign out + sign in regression', () => {
  test('Inbox loads cleanly on the second sign in (no ensureLoaded failures)', async ({ page }, testInfo) => {
    const ensureLoadedFailures = [];
    const consoleLines = [];
    page.on('console', (msg) => {
      const text = msg.text();
      consoleLines.push(`[${msg.type()}] ${text}`);
      if (/\[mail-store\] ensureLoaded failed/.test(text)) {
        ensureLoadedFailures.push(text);
      }
    });
    trackConsole(page, consoleLines);

    await loginViaOidc(page);
    // The point of this regression test is "no ensureLoaded
    // failures", which is detectable via console regardless of
    // whether any Inbox rows have rendered yet. waitForFolderTreeReady
    // (vs waitForInboxReady) waits for the folder tree without
    // requiring rows in the message list — important because the
    // post-sign-out OPFS reset can leave the second sign-in's
    // initial Email/query slower than 30 s under load. The test
    // body's ensureLoadedFailures assertion is the real signal.
    await waitForFolderTreeReady(page);

    // The avatar menu is a <details><summary> pair; <summary> doesn't get
    // exposed as a button in Playwright's accessibility tree across all
    // engines, so target by aria-label instead.
    await page.getByLabel('Open account menu').click();
    await page.getByRole('menuitem', { name: /log out/i }).click();
    await expect(page.getByRole('heading', { name: 'Thundermail' })).toBeVisible({ timeout: 15_000 });

    ensureLoadedFailures.length = 0;

    await loginViaOidc(page);
    await waitForFolderTreeReady(page);

    if (ensureLoadedFailures.length > 0) {
      await testInfo.attach('ensureLoaded-failures.txt', {
        body: ensureLoadedFailures.join('\n\n'),
        contentType: 'text/plain',
      });
      await attachConsoleTail(testInfo, consoleLines);
    }
    expect(
      ensureLoadedFailures,
      `expected no ensureLoaded failures after second sign in; saw:\n${ensureLoadedFailures.join('\n')}`,
    ).toEqual([]);
  });
});
