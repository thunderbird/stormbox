import { test, expect } from '@playwright/test';

/**
 * End-to-end push-delivery regression. Sends a self-addressed
 * message through the live webmail's own compose flow and asserts
 * the new row appears in the open Inbox WITHOUT the user clicking
 * the refresh button.
 *
 * The bug this guards against: when a new mail lands on the server
 * Stalwart pushes an `EmailDelivery` (and `Email` + `Mailbox`)
 * StateChange over the JMAP WebSocket. The sync backend used to
 * skip the active-view refresh in several common branches — most
 * importantly when there was no `Email` baseline state yet, and
 * when the queryChanges delta only contained `removed` items —
 * which meant `query_view_items` (the table the message list reads
 * positionally from) stayed out of date until the user forced a
 * refresh. This test exercises the full vertical slice:
 *
 *    user clicks Send
 *      -> compose store enqueues a pending mutation
 *      -> drainOutbox runs Email/set + EmailSubmission/set
 *      -> server delivers to our own inbox
 *      -> server pushes EmailDelivery + Email + Mailbox StateChange
 *      -> backend._onStateChange refreshes active query views
 *      -> QUERY_VIEW_APPLY_CHANGES updates query_view_items and
 *         broadcasts MESSAGES
 *      -> mail-store.refreshLoadedPages re-reads positionally and
 *         updates state.total + extends the painted range
 *      -> the virtualizer renders a new row with our unique
 *         subject at position 0
 *
 * Skipped unless STAGE_USERNAME / STAGE_PASSWORD are set, same as
 * stage-mail.spec.js. STAGE_SELF_EMAIL can override the recipient
 * if the username isn't already a full address.
 */

const STAGE_USERNAME = process.env.STAGE_USERNAME;
const STAGE_PASSWORD = process.env.STAGE_PASSWORD;
const STAGE_SELF_EMAIL = process.env.STAGE_SELF_EMAIL;

test.skip(
  !STAGE_USERNAME || !STAGE_PASSWORD,
  'STAGE_USERNAME / STAGE_PASSWORD not set; live-stage push-delivery e2e skipped',
);

test.describe('Push delivery to the open Inbox', () => {
  // Account for the full path: JMAP submission round trip + server-
  // side routing into our own inbox + push back over the WebSocket
  // + queryChanges + mail-store re-read + virtualizer rerender.
  // Stalwart loopback is usually under 10s; budget generously.
  test.setTimeout(180_000);

  test('a self-addressed send shows up in Inbox without manual refresh', async ({ page }, testInfo) => {
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

    // Shell + folder tree + inbox auto-select.
    await expect(page.locator('.shell')).toBeVisible({ timeout: 30_000 });
    await expect.poll(
      async () => {
        const current = page.locator('.folder-node.is-current');
        if ((await current.count()) === 0) return null;
        return ((await current.first().textContent()) ?? '').toLowerCase();
      },
      { timeout: 30_000, message: 'expected Inbox to be auto-selected on first connect' },
    ).toMatch(/inbox/);

    // Wait until Inbox has at least one real row painted so we know
    // the WebSocket is open and the initial folder window has
    // landed. Without this we'd race the very first paint against
    // the new-mail push and the assertion below couldn't tell
    // "didn't fire" from "happened too early".
    await expect.poll(
      async () => page.locator('.msg-list__item').count(),
      { timeout: 60_000, message: 'expected the initial Inbox load to paint at least one row' },
    ).toBeGreaterThan(0);

    // Snapshot the current top-row subject so the post-send poll
    // can distinguish "new row arrived" from "list was already
    // showing this".
    const initialTopSubject = (await page
      .locator('.msg-list__item .msg-list__subject')
      .first()
      .textContent() ?? '').trim();
    const initialCount = await page.locator('.msg-list__item').count();
    console.log(`[push-delivery] initial inbox top="${initialTopSubject}" rows=${initialCount}`);

    // Resolve the recipient. STAGE_SELF_EMAIL takes precedence so
    // an OIDC-style "shortname" STAGE_USERNAME can still be paired
    // with a full address. Otherwise fall back to the rendered
    // account label, then to STAGE_USERNAME itself.
    const accountLabel = (await page
      .locator('.sidebar__account-name')
      .textContent() ?? '').trim();
    const selfEmail = STAGE_SELF_EMAIL
      || (accountLabel.includes('@') ? accountLabel : null)
      || (STAGE_USERNAME.includes('@') ? STAGE_USERNAME : null);
    if (!selfEmail) {
      throw new Error(
        'Could not determine the test account\'s email address. '
        + 'Set STAGE_SELF_EMAIL to a full RFC-822 address.',
      );
    }
    const subjectMarker = `Push test ${Date.now()}`;
    console.log(`[push-delivery] sending to ${selfEmail} with subject "${subjectMarker}"`);

    // Open compose.
    await page.getByRole('button', { name: /new message/i }).click();
    await expect(page.locator('.compose-dialog')).toBeVisible({ timeout: 10_000 });

    // Compose store's send() requires at least one identity. Wait
    // until the From <select> has at least one option, otherwise
    // sending fails with "No identities are configured".
    await expect.poll(
      async () => page.locator('.compose-dialog select option').count(),
      { timeout: 30_000, message: 'expected identities to populate the From select' },
    ).toBeGreaterThan(0);

    // Fill the To row. There are multiple text inputs in the
    // dialog (subject also matches); the first text input under
    // the "To" row is what we want.
    const toInput = page.locator('.compose-dialog .row').filter({ hasText: 'To' }).locator('input[type="text"]');
    await toInput.fill(selfEmail);

    const subjectInput = page.locator('.compose-dialog .row').filter({ hasText: 'Subject' }).locator('input[type="text"]');
    await subjectInput.fill(subjectMarker);

    // Body: the Squire editor is contenteditable. Click to focus
    // then type. An empty body is allowed by JMAP submission, but
    // typing something makes the test more representative of a
    // real send and ensures rich-text init didn't blow up.
    await page.locator('.compose-dialog .editor').click();
    await page.keyboard.type('push delivery regression');

    const sendButton = page.locator('.compose-dialog footer .primary');
    await sendButton.click();

    // The dialog closes as soon as compose-store.send resolves
    // (drainOutbox finished). After that the message is on its way
    // through the server's local delivery path.
    await expect(page.locator('.compose-dialog')).toHaveCount(0, { timeout: 60_000 });
    const sendCompletedAt = Date.now();

    // Make absolutely sure we're back on Inbox (compose.send()
    // doesn't navigate, but a previous test action might have).
    const inboxRow = page.locator('.folder-node').filter({ hasText: /^inbox/i }).first();
    if ((await inboxRow.locator('..').filter({ has: page.locator('.is-current') }).count()) === 0) {
      // Idempotent: clicking Inbox when it's already current is a
      // no-op selectFolder.
      await inboxRow.click();
      await expect.poll(
        async () => {
          const current = page.locator('.folder-node.is-current');
          if ((await current.count()) === 0) return null;
          return ((await current.first().textContent()) ?? '').toLowerCase();
        },
        { timeout: 10_000 },
      ).toMatch(/inbox/);
    }

    // DO NOT click refresh. The whole point is that the row must
    // appear under pure push. Poll the rendered top subject; it
    // should switch to our marker once the loopback delivery
    // round-trips through Stalwart.
    let observedTopSubject = initialTopSubject;
    await expect.poll(
      async () => {
        observedTopSubject = (await page
          .locator('.msg-list__item .msg-list__subject')
          .first()
          .textContent() ?? '').trim();
        return observedTopSubject;
      },
      {
        timeout: 120_000,
        message: `expected a new top row with subject "${subjectMarker}" to appear via push within 120s of send completing`,
      },
    ).toBe(subjectMarker);

    const pushArrivedMs = Date.now() - sendCompletedAt;
    console.log(`[push-delivery] new row visible ${pushArrivedMs}ms after send completed`);

    // Sanity: the refresh button must NOT have been clicked, and
    // the new row must be a real row (not a placeholder skeleton).
    const newTopIsReal = await page.locator('.msg-list__items > li').first().evaluate(
      (li) => li.dataset.placeholder !== 'true',
    );
    expect(newTopIsReal).toBe(true);

    // The list count should have grown by exactly one. (More than
    // one is also a pass — other senders may have delivered in
    // parallel — but we want to assert it didn't shrink and didn't
    // stay the same.)
    const finalCount = await page.locator('.msg-list__item').count();
    expect(finalCount).toBeGreaterThan(initialCount);

    await testInfo.attach('console-tail.txt', {
      body: consoleLines.slice(-100).join('\n'),
      contentType: 'text/plain',
    });
  });
});
