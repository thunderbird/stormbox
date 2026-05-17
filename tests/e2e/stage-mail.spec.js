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
  test.setTimeout(120_000);

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
    const after = await page.screenshot({ fullPage: true });
    await testInfo.attach(`${browserName}-after-login.png`, { body: after, contentType: 'image/png' });
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
    // body_values is read back). Poll until either an html or text
    // body element appears, with the placeholder message-view__placeholder
    // disappearing.
    await expect.poll(
      async () => {
        const html = await page.locator('.message-view__html').count();
        const text = await page.locator('.message-view__text').count();
        return html + text;
      },
      {
        timeout: 30_000,
        message: 'expected the message body to render as html or text',
      },
    ).toBeGreaterThan(0);

    const msgShot = await page.screenshot({ fullPage: true });
    await testInfo.attach(`${browserName}-message-opened.png`, { body: msgShot, contentType: 'image/png' });
    await page.screenshot({ path: `screenshots/${browserName}-03-message-opened.png`, fullPage: true });

    // 5. Verify message list scrolls. Pages with 32 messages must
    //    overflow the viewport at our default sizes.
    const scrollable = await page.evaluate(() => {
      const el = document.querySelector('.msg-list__items');
      if (!el) return null;
      return { sh: el.scrollHeight, ch: el.clientHeight, overflow: el.scrollHeight > el.clientHeight };
    });
    console.log(`[test] msg-list scroll metrics: ${JSON.stringify(scrollable)}`);
    if (!scrollable?.overflow) {
      throw new Error(`Message list is not scrollable: ${JSON.stringify(scrollable)}`);
    }
    // Actually scroll and check that scrollTop moves.
    const scrolledTo = await page.evaluate(() => {
      const el = document.querySelector('.msg-list__items');
      el.scrollTop = 200;
      return el.scrollTop;
    });
    if (scrolledTo === 0) {
      throw new Error('Message list did not respond to scrollTop');
    }

    // 6. Open the compose dialog and make sure Squire RTE mounted.
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
