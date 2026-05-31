import { test, expect } from '@playwright/test';

import {
  connectJmap,
  createEmailInMailbox,
  ensureArchiveMailbox,
  ensureArchivePopulated,
  ensureInboxBaseline,
  listMailboxes,
  mailboxByRole,
  sweepOrphanTestMessages,
} from './helpers/jmap-client.js';
import { loginViaOidc } from './helpers/oidc-login.js';
import {
  localStackEnabled,
  selfEmail,
  skipLocalStackMessage,
} from './helpers/stack-env.js';
import { attachConsoleTail, trackConsole, waitForInboxReady } from './helpers/ui.js';

/**
 * End-to-end against the local thunderbird-accounts stack (Keycloak +
 * Stalwart) using OIDC sign-in.
 *
 * Asserts the full vertical slice the user actually cares about:
 *   1. Login completes and the shell renders
 *   2. The folder tree shows at least one folder (typically Inbox)
 *   3. Selecting the inbox loads at least one message into the list
 *   4. Selecting a message renders its body in the detail pane
 */

function tallHtmlBody() {
  return `<main>${Array.from({ length: 24 }, (_, index) => (
    `<p>Mail flow tall HTML paragraph ${index + 1}: ${'content '.repeat(12)}</p>`
  )).join('')}</main>`;
}

test.skip(!localStackEnabled, skipLocalStackMessage);

test.describe('Local stack mail flow e2e', () => {
  // Idempotent account preconditions:
  //   - Archive role mailbox + 1500 seeded messages for the
  //     deep-scroll assertion at the bottom of the test.
  //   - 12 baseline Inbox messages so the Inbox-scrollable
  //     assertion has enough rows to fill the scroller.
  // Both no-op on a populated account, so re-runs are cheap;
  // a fresh tmpfs Stalwart pays ~7 s once for the archive seed.
  test.beforeAll(async () => {
    const jmap = await connectJmap();
    const archive = await ensureArchiveMailbox(jmap);
    await ensureArchivePopulated(jmap, {
      archiveMailboxId: archive.id,
      fromEmail: selfEmail(),
    });
    const mailboxes = await listMailboxes(jmap);
    const inbox = mailboxByRole(mailboxes, 'inbox');
    if (!inbox) throw new Error('Test requires Inbox mailbox');
    await ensureInboxBaseline(jmap, {
      inboxMailboxId: inbox.id,
      fromEmail: selfEmail(),
    });
  });

  test.beforeEach(async () => {
    const jmap = await connectJmap();
    await sweepOrphanTestMessages(jmap, { subjectPrefix: 'Mail flow e2e' });
  });

  test.afterEach(async () => {
    const jmap = await connectJmap();
    await sweepOrphanTestMessages(jmap, { subjectPrefix: 'Mail flow e2e' });
  });

  test('login -> folder tree -> messages -> message body', async ({ page, browserName }, testInfo) => {
    const consoleLines = [];
    trackConsole(page, consoleLines);

    const jmap = await connectJmap();
    const mailboxes = await listMailboxes(jmap);
    const inbox = mailboxByRole(mailboxes, 'inbox');
    if (!inbox) throw new Error('Test requires Inbox mailbox');

    const stamp = Date.now();
    const subjects = [
      `Mail flow e2e ${stamp} tall`,
      `Mail flow e2e ${stamp} second`,
    ];
    const secondRemoteId = await createEmailInMailbox(jmap, {
      mailboxId: inbox.id,
      fromEmail: selfEmail(),
      subject: subjects[1],
      bodyText: 'Mail flow second message body.',
    });
    await createEmailInMailbox(jmap, {
      mailboxId: inbox.id,
      fromEmail: selfEmail(),
      subject: subjects[0],
      bodyText: 'Mail flow tall HTML fallback text.',
      htmlBody: tallHtmlBody(),
    });

    await loginViaOidc(page);

    const afterLogin = await page.screenshot({ fullPage: true });
    await testInfo.attach(`${browserName}-after-login.png`, { body: afterLogin, contentType: 'image/png' });
    await page.screenshot({ path: `screenshots/${browserName}-01-after-login.png`, fullPage: true });

    // Cold-boot in CI can take >30s for the worker to bring up the
    // OPFS DB, finish the OIDC handshake, and land the first
    // ensureFolderWindow round trip. waitForInboxReady carries the
    // project-wide 60s budget; mail-flow used to duplicate the same
    // assertion with a 30s budget which produced the flake.
    await waitForInboxReady(page);
    for (const subject of subjects) {
      await expect.poll(
        async () => page.locator('.msg-list__item').filter({ hasText: subject }).count(),
        { timeout: 30_000, message: `expected test message "${subject}" to render in Inbox` },
      ).toBeGreaterThan(0);
    }

    const folderRows = page.locator('.folder-node');
    const folderCount = await folderRows.count();
    const folderNames = [];
    for (let i = 0; i < folderCount; i += 1) {
      folderNames.push(((await folderRows.nth(i).textContent()) ?? '').trim());
    }
    console.log(`[test] folders rendered: ${JSON.stringify(folderNames)}`);

    const folderShot = await page.screenshot({ fullPage: true });
    await testInfo.attach(`${browserName}-folder-opened.png`, { body: folderShot, contentType: 'image/png' });
    await page.screenshot({ path: `screenshots/${browserName}-02-folder-opened.png`, fullPage: true });

    // Open the "second" message by subject rather than .first(). The
    // "tall" message is created last and usually sorts to row 0, so a
    // .first() click here would land on the same row the targetClick
    // below opens — and a plain click on the already-previewed row
    // toggles the preview closed (R-3.6), emptying the reading pane.
    // Opening a deterministically different row keeps the two opens
    // independent regardless of the received-time tiebreak.
    await page.locator('.msg-list__item').filter({ hasText: subjects[1] }).first()
      .locator('.msg-list__content').click();

    await expect(page.locator('.message-view__title h2')).toBeVisible({ timeout: 30_000 });

    await expect.poll(
      async () => {
        const frame = await page.locator('iframe.message-view__html-frame').count();
        const text = await page.locator('.message-view__text').count();
        return frame + text;
      },
      {
        timeout: 30_000,
        message: 'expected the message body to render as the iframe or the text fallback',
      },
    ).toBeGreaterThan(0);

    if ((await page.locator('iframe.message-view__html-frame').count()) > 0) {
      const frameInfo = await page.evaluate(() => {
        const ifr = document.querySelector('iframe.message-view__html-frame');
        if (!ifr) return null;
        return {
          sandbox: ifr.getAttribute('sandbox') ?? '',
          srcdoc: ifr.getAttribute('srcdoc') ?? '',
          paneWidth: ifr.parentElement?.getBoundingClientRect().width ?? 0,
          frameWidth: ifr.getBoundingClientRect().width,
          marginLeft: parseFloat(getComputedStyle(ifr).marginLeft || '0') || 0,
        };
      });
      if (!frameInfo) throw new Error('expected message-view html iframe to be present');
      if (!/allow-same-origin/.test(frameInfo.sandbox)) {
        throw new Error(`iframe missing allow-same-origin: sandbox="${frameInfo.sandbox}"`);
      }
      if (/allow-scripts/.test(frameInfo.sandbox)) {
        throw new Error(`iframe must not grant allow-scripts: sandbox="${frameInfo.sandbox}"`);
      }
      if (!frameInfo.srcdoc.startsWith('<!DOCTYPE html>')) {
        throw new Error('iframe srcdoc must be a complete HTML document');
      }
      if (!frameInfo.srcdoc.includes('Content-Security-Policy')) {
        throw new Error('iframe srcdoc must embed a CSP meta tag');
      }
      const expectedWidth = Math.max(0, frameInfo.paneWidth - frameInfo.marginLeft);
      if (frameInfo.paneWidth > 0 && Math.abs(frameInfo.frameWidth - expectedWidth) > 2) {
        throw new Error(
          `iframe width ${frameInfo.frameWidth}px did not match pane ${frameInfo.paneWidth}px minus inset ${frameInfo.marginLeft}px`,
        );
      }
    }

    const targetClick = page.locator('.msg-list__item')
      .filter({ hasText: subjects[0] })
      .first();
    if ((await targetClick.count()) > 0) {
      await targetClick.locator('.msg-list__content').click();
      await expect(page.locator('.message-view__title h2')).toBeVisible({ timeout: 30_000 });
      await expect.poll(
        async () => {
          const frame = await page.locator('iframe.message-view__html-frame').count();
          const text = await page.locator('.message-view__text').count();
          return frame + text;
        },
        { timeout: 20_000, message: 'iframe height inline style never grew past 120px' },
      ).toBeGreaterThan(0);
      await expect.poll(
        async () => page.evaluate(() => {
          const ifr = document.querySelector('iframe.message-view__html-frame');
          if (!ifr) return 0;
          const inline = ifr.style.height || '';
          return parseInt(inline, 10) || 0;
        }),
        { timeout: 20_000, message: 'iframe height inline style never grew past 120px' },
      ).toBeGreaterThan(120);

      const scrollProbe = await page.evaluate(() => {
        const bodyEl = document.querySelector('.message-view__body');
        if (!bodyEl) return null;
        const style = window.getComputedStyle(bodyEl);
        const before = bodyEl.scrollTop;
        bodyEl.scrollTop = 200;
        const after = bodyEl.scrollTop;
        bodyEl.scrollTop = 0;
        return {
          overflowY: style.overflowY,
          clientHeight: bodyEl.clientHeight,
          scrollHeight: bodyEl.scrollHeight,
          scrollResponded: after > before,
        };
      });
      if (!scrollProbe) throw new Error('expected .message-view__body to be present');
      if (scrollProbe.overflowY !== 'auto' && scrollProbe.overflowY !== 'scroll') {
        throw new Error(
          `message-view body must scroll vertically; overflow-y="${scrollProbe.overflowY}"`,
        );
      }
      // The iframe is allowed to grow to fit this fixture when the viewport is tall enough;
      // the dedicated iframe-height spec covers long-body growth and refresh behavior.
    }

    if (await page.locator('.msg-list__item').count() > 1) {
      // Wait for the body prefetch to actually populate the cache for
      // the second-position message before we click it. The previous
      // version of this test slept 750ms and hoped — on a cold
      // WebSocket connection that was a coin flip and produced the
      // "expected second message body to render quickly after
      // prefetch" flake. Polling body_fetched_at via the test seam is
      // deterministic: we move on the moment the prefetch lands, and
      // the click→render budget below stays tight enough to catch a
      // real regression.
      await expect.poll(
        async () => page.evaluate(async (remoteId) => {
          if (!globalThis.__repo) return 0;
          const accounts = await globalThis.__repo.listAccounts();
          const account = accounts?.[0];
          if (!account) return 0;
          const folders = await globalThis.__repo.listFolders(account.id);
          const inbox = folders.find((f) => f.role === 'inbox');
          if (!inbox) return 0;
          const rows = await globalThis.__repo.listMessagesForView({
            accountId: account.id,
            folderId: inbox.id,
            sort: 'received',
            offset: 0,
            limit: 20,
          });
          const target = rows?.find((row) => row.remote_id === remoteId);
          return Number(target?.body_fetched_at ?? 0);
        }, secondRemoteId),
        {
          timeout: 30_000,
          message: 'second-position body never landed in the cache via prefetch',
        },
      ).toBeGreaterThan(0);

      const secondStart = Date.now();
      const secondRow = page.locator('.msg-list__item')
        .filter({ hasText: subjects[1] })
        .first();
      await secondRow.locator('.msg-list__content').click();
      await expect(page.locator('.message-view__title h2')).toHaveText(subjects[1], { timeout: 5_000 });
      await expect.poll(
        async () => {
          const frame = await page.locator('iframe.message-view__html-frame').count();
          const text = await page.locator('.message-view__text').count();
          return frame + text;
        },
        {
          timeout: 5_000,
          message: 'second-message body should render fast once prefetched',
        },
      ).toBeGreaterThan(0);
      const secondBodyMs = Date.now() - secondStart;
      console.log(`[test] second message body after prefetch: ${secondBodyMs}ms`);
      if (secondBodyMs > 1_000) {
        throw new Error(`second message body took ${secondBodyMs}ms after prefetch was confirmed cached`);
      }
    }

    const msgShot = await page.screenshot({ fullPage: true });
    await testInfo.attach(`${browserName}-message-opened.png`, { body: msgShot, contentType: 'image/png' });
    await page.screenshot({ path: `screenshots/${browserName}-03-message-opened.png`, fullPage: true });

    const initial = await page.evaluate(() => {
      const sc = document.querySelector('.msg-list__scroller');
      const inner = document.querySelector('.msg-list__items');
      if (!sc || !inner) return null;
      return {
        scrollHeight: sc.scrollHeight,
        clientHeight: sc.clientHeight,
        innerHeight: inner.offsetHeight,
        topRowIndex: Number(document.querySelector('.msg-list__items > li')?.dataset.index ?? -1),
      };
    });
    console.log(`[test] msg-list initial: ${JSON.stringify(initial)}`);
    if (!initial || initial.scrollHeight <= initial.clientHeight) {
      throw new Error(`Message list is not scrollable: ${JSON.stringify(initial)}`);
    }
    const after = await page.evaluate(async () => {
      const sc = document.querySelector('.msg-list__scroller');
      sc.scrollTop = sc.scrollHeight / 2;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const lis = Array.from(document.querySelectorAll('.msg-list__items > li'));
      return {
        scrollTop: sc.scrollTop,
        firstRowIndex: Number(lis[0]?.dataset.index ?? -1),
        lastRowIndex: Number(lis[lis.length - 1]?.dataset.index ?? -1),
        rowCount: lis.length,
      };
    });
    console.log(`[test] msg-list after scroll: ${JSON.stringify(after)}`);
    if (after.scrollTop === 0) {
      throw new Error('Message list did not respond to scrollTop');
    }
    if (initial.scrollHeight > 10_000 && after.firstRowIndex < 100) {
      throw new Error(`Virtualiser still showing low rows after mid-scroll: first=${after.firstRowIndex}`);
    }

    const archives = page.locator('.folder-node').filter({ hasText: /archive/i }).first();
    if (await archives.count() > 0) {
      await archives.click();
      await expect.poll(
        async () => page.evaluate(() => {
          const inner = document.querySelector('.msg-list__items');
          if (!inner) return 0;
          return Math.round(inner.offsetHeight / 88);
        }),
        { timeout: 30_000, message: 'archives total never landed on the scrollbar' },
      ).toBeGreaterThan(1000);

      await expect.poll(
        async () => page.evaluate(() => {
          const real = Array.from(document.querySelectorAll('.msg-list__items > li'))
            .filter((li) => li.dataset.placeholder !== 'true');
          return real.length;
        }),
        { timeout: 20_000, message: 'page 0 never painted real rows' },
      ).toBeGreaterThan(0);

      // Cap the in-page hydrate poll at 15s (75×200ms) so a hung
      // ensureFolderWindow fails fast against the spec's 60s budget,
      // with headroom for the rest of the assertions below.
      const archivesScroll = await page.evaluate(async () => {
        const sc = document.querySelector('.msg-list__scroller');
        sc.scrollTop = 1500 * 88;
        for (let i = 0; i < 75; i += 1) {
          await new Promise((r) => setTimeout(r, 200));
          const lis = Array.from(document.querySelectorAll('.msg-list__items > li'));
          const real = lis.filter((li) => li.dataset.placeholder !== 'true');
          const idx = real.map((li) => Number(li.dataset.index));
          if (idx.length && Math.max(...idx) >= 1400) {
            return {
              scrollTop: sc.scrollTop,
              rendered: lis.length,
              firstReal: Math.min(...idx),
              lastReal: Math.max(...idx),
              tookMs: i * 200,
            };
          }
        }
        return { timedOut: true };
      });
      console.log(`[test] archives mid-scroll: ${JSON.stringify(archivesScroll)}`);
      if (archivesScroll.timedOut) {
        throw new Error('Archives lazy fetch did not hydrate row >= 1400');
      }
      if (archivesScroll.rendered > 60) {
        throw new Error(`Virtualiser rendered too many rows (${archivesScroll.rendered}); should be ~30`);
      }
      await page.screenshot({ path: `screenshots/${browserName}-05-archives-scrolled.png`, fullPage: true });

      // Use the accessible name so we don't accidentally match other
      // folder rows whose name starts with "Inbox" (e.g. "Inbox Archive"
      // or future shared folders). hasText against textContent is
      // brittle because the icon SVG adds leading whitespace inside
      // the button.
      const inboxRow = page.getByRole('button', { name: /^Inbox(\s|$)/i });
      const navStart = Date.now();
      await inboxRow.click();
      await expect.poll(
        async () => page.evaluate(() => {
          const real = Array.from(document.querySelectorAll('.msg-list__items > li'))
            .filter((li) => li.dataset.placeholder !== 'true');
          return real.length;
        }),
        { timeout: 1_000, message: 'inbox re-entry did not paint cached rows quickly' },
      ).toBeGreaterThan(0);
      const navMs = Date.now() - navStart;
      console.log(`[test] inbox re-entry paint: ${navMs}ms`);
      if (navMs > 500) {
        throw new Error(`inbox re-entry took ${navMs}ms; should be < 500ms (cache hit)`);
      }
      const spinnerVisible = await page.locator('.msg-list__loader').count();
      if (spinnerVisible > 0) {
        throw new Error('inbox re-entry showed the loading spinner; should be cache-only');
      }
    }

    await page.getByRole('button', { name: /new message/i }).click();
    await expect(page.locator('.compose-dialog')).toBeVisible({ timeout: 5_000 });
    const composeOk = await page.evaluate(() => {
      const editor = document.querySelector('.compose-dialog .editor');
      return !!editor && editor.isContentEditable;
    });
    if (!composeOk) {
      throw new Error('Compose editor did not mount as contenteditable');
    }
    await page.screenshot({ path: `screenshots/${browserName}-04-compose-open.png`, fullPage: true });
    await page.getByRole('button', { name: /^discard$/i }).click();

    await attachConsoleTail(testInfo, consoleLines, 80);
  });
});
