import { test, expect } from '@playwright/test';

/**
 * End-to-end against the live stage server (mail.stage-thundermail.com)
 * using the app-password flow (the same password as OIDC; basic auth
 * is accepted at the JMAP endpoint).
 *
 * Skips unless STAGE_USERNAME and STAGE_PASSWORD are set in the env.
 * Run: STAGE_USERNAME=... STAGE_PASSWORD=... npx playwright test stage-mail.spec.js
 *
 * Asserts the full vertical slice the user actually cares about:
 *   1. Login completes and the shell renders
 *   2. The folder tree shows at least one folder (typically Inbox)
 *   3. Selecting the inbox loads at least one message into the list
 *   4. Selecting a message renders its body in the detail pane
 */

const STAGE_USERNAME = process.env.STAGE_USERNAME;
const STAGE_PASSWORD = process.env.STAGE_PASSWORD;

test.skip(
  !STAGE_USERNAME || !STAGE_PASSWORD,
  'STAGE_USERNAME / STAGE_PASSWORD not set; live-stage e2e skipped',
);

test.describe('Stage Thundermail e2e', () => {
  // Firefox's async OPFS VFS is 5-10x slower than Chromium for bulk
  // writes. The Archives leg pulls two 100-message pages over the
  // network and persists them via persistEmails (~500 SQL ops each
  // behind the engine lock), so we leave a generous budget.
  test.setTimeout(180_000);

  test('login -> folder tree -> messages -> message body', async ({ page, browserName }, testInfo) => {
    const consoleLines = [];
    page.on('console', (msg) => {
      consoleLines.push(`[${msg.type()}] ${msg.text()}`);
    });
    page.on('pageerror', (err) => {
      consoleLines.push(`[pageerror] ${err.message}`);
    });

    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Thundermail' })).toBeVisible();
    await page.getByRole('button', { name: /use app password instead/i }).click();
    await page.getByLabel('Username').fill(STAGE_USERNAME);
    await page.getByLabel('App password').fill(STAGE_PASSWORD);
    await page.getByRole('button', { name: /^sign in$/i }).click();

    // 1. Shell appears.
    await expect(page.locator('.shell')).toBeVisible({ timeout: 30_000 });
    const afterLogin = await page.screenshot({ fullPage: true });
    await testInfo.attach(`${browserName}-after-login.png`, { body: afterLogin, contentType: 'image/png' });
    await page.screenshot({ path: `screenshots/${browserName}-01-after-login.png`, fullPage: true });

    // 2. Folder tree populates with at least one row.
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

    // 3. Inbox should auto-load without a click. The auto-select fires
    //    as soon as the inbox folder lands in the local cache.
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

    // 4. Open the first message and wait for its body.
    await page.locator('.msg-list__item').first().click();

    await expect(page.locator('.message-view__title h2')).toBeVisible({ timeout: 30_000 });

    // The body fetch is async (ensureMessageBody hits the server, then
    // body_values is read back). Poll until either the HTML iframe or
    // the plain-text fallback appears, with the
    // message-view__placeholder disappearing.
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

    // If we ended up on the HTML path, pin the security contract: the
    // iframe is sandboxed without allow-scripts (so a stray <script>
    // in any email is inert at runtime), and its srcdoc carries the
    // email body wrapped in a CSP'd document. The point of these
    // assertions is that the rendering path stays "iframe-with-srcdoc
    // + sandbox" forever — the earlier inline-HTML path silently let
    // every email's <style> bleed across the host UI.
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
      // The iframe paints across the full message-view body so a wide
      // email can render in its own design width with whitespace
      // around it (rather than being clipped to some inner column).
      if (frameInfo.paneWidth > 0 && frameInfo.frameWidth < frameInfo.paneWidth - 2) {
        throw new Error(
          `iframe is narrower than its pane: ${frameInfo.frameWidth}px in a ${frameInfo.paneWidth}px pane`,
        );
      }
    }

    // Layout regression — proven by clicking a known-tall HTML email.
    // The first message in this stage inbox is a one-line plaintext
    // ("test"), so we look for a marketing email with measurable body
    // height. PledgeBox is reliably present in the seeded fixture
    // and is also the visual regression that drove this work; if it
    // ever falls out of the seed we degrade to "any message whose
    // iframe ends up taller than the visible body".
    const tallCandidate = page.locator('.msg-list__item')
      .filter({ hasText: /pledgebox/i })
      .first();
    const targetClick = (await tallCandidate.count()) > 0
      ? tallCandidate
      : page.locator('.msg-list__item').nth(1);
    if ((await targetClick.count()) > 0) {
      await targetClick.click();
      // Wait for the iframe to (a) exist and (b) finish auto-sizing
      // — onIframeLoad sets style.height once the srcdoc has laid
      // out, replacing the initial 120-px reservation with the real
      // content height.
      await expect.poll(
        async () => page.evaluate(() => {
          const ifr = document.querySelector('iframe.message-view__html-frame');
          if (!ifr) return 0;
          const inline = ifr.style.height || '';
          return parseInt(inline, 10) || 0;
        }),
        { timeout: 30_000, message: 'iframe height inline style never grew past 120px' },
      ).toBeGreaterThan(120);

      // Now actually verify scrolling works: the body is a real
      // overflow-y scroll container, AND when the iframe is taller
      // than the body's visible area the body responds to scrollTop.
      // This is what guards against the article-grid layout regression
      // that made tall emails unscrollable (PledgeBox bug).
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

    // Body prefetch: opening the first message enqueues nearby bodies.
    // Give the single-concurrency body queue a short moment, then
    // click the second message. It should render quickly from the
    // prefetched cache (or from a nearly-complete prefetch), not go
    // through the full cold path.
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

    // 5. Verify the (virtualised) message list actually scrolls and
    //    that the visible window changes when we scroll. The inner
    //    .msg-list__items has total height = totalSize, the outer
    //    .msg-list__scroller is what owns the scrollbar.
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
    // Scroll halfway down and confirm the rendered window moves.
    const after = await page.evaluate(async () => {
      const sc = document.querySelector('.msg-list__scroller');
      sc.scrollTop = sc.scrollHeight / 2;
      // Yield two frames so the virtualiser's scroll listener can run.
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
    // The virtualiser should be rendering rows around the middle of
    // the list, not the top. For a folder with hundreds of messages
    // the visible window must include indices well past row 100.
    if (initial.scrollHeight > 10_000 && after.firstRowIndex < 100) {
      throw new Error(`Virtualiser still showing low rows after mid-scroll: first=${after.firstRowIndex}`);
    }

    // 6. Switch to Archives (~3k messages). Confirm:
    //    a) The scrollbar reflects the FOLDER TOTAL after the first
    //       Email/query, not just the loaded count.
    //    b) Scrolling deep into the unloaded region renders skeleton
    //       placeholders and triggers ensureLoaded prefetches that
    //       hydrate the visible window.
    //    c) Virtualisation is real: ~30 rendered rows even at row 1500.
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

      // Wait for page 0 to paint at least one real row before scrolling.
      // Firefox's async OPFS VFS is materially slower than Chromium's
      // sync access handles for bulk writes (the 100-message
      // persistEmails for one page can take 30s+); bump the budget.
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
        // Up to 60s; Stalwart's deep Email/query + Email/get is ~1.4s
        // and persistEmails for 100 records does ~500 OPFS writes
        // behind the engine lock. Firefox's async OPFS path is
        // significantly slower than Chromium's sync access handles.
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

      // Switch back to Inbox: this MUST be cached, no spinner, paints
      // synchronously. The paint criterion is "real rows visible
      // within 250 ms of the click", which only works when the
      // selectFolder path reuses folderStates.
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

    // 7. Open the compose dialog and make sure Squire RTE mounted.
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

    // Dump last 80 console lines so failures are diagnosable from the
    // terminal output alone.
    await testInfo.attach('console-tail.txt', {
      body: consoleLines.slice(-80).join('\n'),
      contentType: 'text/plain',
    });
  });
});
