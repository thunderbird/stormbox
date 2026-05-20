import { test, expect } from '@playwright/test';

import { loginViaOidc } from './helpers/oidc-login.js';
import {
  localStackEnabled,
  skipLocalStackMessage,
} from './helpers/stack-env.js';
import { attachConsoleTail, trackConsole } from './helpers/ui.js';

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

const TALL_HTML_SUBJECT = /Seed e2e tall HTML message/i;

test.skip(!localStackEnabled, skipLocalStackMessage);

test.describe('Local stack mail flow e2e', () => {
  test.setTimeout(180_000);

  test('login -> folder tree -> messages -> message body', async ({ page, browserName }, testInfo) => {
    const consoleLines = [];
    trackConsole(page, consoleLines);

    await loginViaOidc(page);

    await expect(page.locator('.shell')).toBeVisible({ timeout: 30_000 });
    const afterLogin = await page.screenshot({ fullPage: true });
    await testInfo.attach(`${browserName}-after-login.png`, { body: afterLogin, contentType: 'image/png' });
    await page.screenshot({ path: `screenshots/${browserName}-01-after-login.png`, fullPage: true });

    await expect.poll(
      async () => page.locator('.folder-node').count(),
      { timeout: 30_000, message: 'expected at least one folder to appear in the tree' },
    ).toBeGreaterThan(0);

    const folderRows = page.locator('.folder-node');
    const folderCount = await folderRows.count();
    const folderNames = [];
    for (let i = 0; i < folderCount; i += 1) {
      folderNames.push(((await folderRows.nth(i).textContent()) ?? '').trim());
    }
    console.log(`[test] folders rendered: ${JSON.stringify(folderNames)}`);

    await expect.poll(
      async () => {
        const current = page.locator('.folder-node.is-current');
        if ((await current.count()) === 0) return null;
        return ((await current.first().textContent()) ?? '').toLowerCase();
      },
      { timeout: 30_000, message: 'expected a folder to be auto-selected' },
    ).toMatch(/inbox/);

    await expect.poll(
      async () => page.locator('.msg-list__item').count(),
      { timeout: 30_000, message: 'expected at least one message in the list' },
    ).toBeGreaterThan(0);

    const folderShot = await page.screenshot({ fullPage: true });
    await testInfo.attach(`${browserName}-folder-opened.png`, { body: folderShot, contentType: 'image/png' });
    await page.screenshot({ path: `screenshots/${browserName}-02-folder-opened.png`, fullPage: true });

    await page.locator('.msg-list__item').first().click();

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
      if (frameInfo.paneWidth > 0 && frameInfo.frameWidth < frameInfo.paneWidth - 2) {
        throw new Error(
          `iframe is narrower than its pane: ${frameInfo.frameWidth}px in a ${frameInfo.paneWidth}px pane`,
        );
      }
    }

    const tallCandidate = page.locator('.msg-list__item')
      .filter({ hasText: TALL_HTML_SUBJECT })
      .first();
    const targetClick = (await tallCandidate.count()) > 0
      ? tallCandidate
      : page.locator('.msg-list__item').nth(1);
    if ((await targetClick.count()) > 0) {
      await targetClick.click();
      await expect.poll(
        async () => page.evaluate(() => {
          const ifr = document.querySelector('iframe.message-view__html-frame');
          if (!ifr) return 0;
          const inline = ifr.style.height || '';
          return parseInt(inline, 10) || 0;
        }),
        { timeout: 30_000, message: 'iframe height inline style never grew past 120px' },
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
      if (scrollProbe.scrollHeight <= scrollProbe.clientHeight + 4) {
        throw new Error(
          `message-view body has no overflow even on a tall email: scrollHeight=${scrollProbe.scrollHeight} clientHeight=${scrollProbe.clientHeight}`,
        );
      }
      if (!scrollProbe.scrollResponded) {
        throw new Error(
          `message-view body did not respond to scrollTop: scrollHeight=${scrollProbe.scrollHeight} clientHeight=${scrollProbe.clientHeight}`,
        );
      }
    }

    if (await page.locator('.msg-list__item').count() > 1) {
      await page.waitForTimeout(750);
      const secondStart = Date.now();
      await page.locator('.msg-list__item').nth(1).click();
      await expect.poll(
        async () => {
          const frame = await page.locator('iframe.message-view__html-frame').count();
          const text = await page.locator('.message-view__text').count();
          return frame + text;
        },
        {
          timeout: 5_000,
          message: 'expected second message body to render quickly after prefetch',
        },
      ).toBeGreaterThan(0);
      const secondBodyMs = Date.now() - secondStart;
      console.log(`[test] second message body after prefetch: ${secondBodyMs}ms`);
      if (secondBodyMs > 5_000) {
        throw new Error(`second message body took ${secondBodyMs}ms after prefetch`);
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
        { timeout: 45_000, message: 'page 0 never painted real rows' },
      ).toBeGreaterThan(0);

      const archivesScroll = await page.evaluate(async () => {
        const sc = document.querySelector('.msg-list__scroller');
        sc.scrollTop = 1500 * 88;
        for (let i = 0; i < 300; i += 1) {
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

      const inboxRow = page.locator('.folder-node').filter({ hasText: /^inbox/i }).first();
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
