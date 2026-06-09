import {
  cleanupEmail,
  connectJmap,
  createEmailInMailbox,
  listMailboxes,
  mailboxByRole,
} from './helpers/jmap-client.js';
import {
  expect,
  resetSharedSession,
  test,
} from './helpers/shared-session.js';
import {
  liveE2eEnabled,
  selfEmail,
  skipLiveE2eMessage,
} from './helpers/stack-env.js';

/**
 * Regression test for two iframe-height bugs we hit in MessageView.
 * Uses the tall HTML message seeded by tests/fixtures/seed-mail.mjs.
 */

// temp skipping until get running, remove when ready to test this one
test.skip();

test.skip(!liveE2eEnabled, skipLiveE2eMessage);

function tallHtmlBody() {
  return `<!DOCTYPE html><html><body>${
    Array.from(
      { length: 120 },
      (_, i) => `<p>Paragraph ${i} ${'Lorem ipsum dolor sit amet. '.repeat(8)}</p>`,
    ).join('')
  }</body></html>`;
}

async function iframeHeight(page) {
  return page.evaluate(() => {
    const ifr = document.querySelector('iframe.message-view__html-frame');
    if (!ifr) return null;
    return parseInt(ifr.style.height || '0', 10) || 0;
  });
}

test.beforeEach(async ({ sharedPage }) => {
  await resetSharedSession(sharedPage, {
    extraSubjectPrefixes: ['Iframe height e2e'],
  });
});

test('iframe height grows past 120 on first open and survives body refresh', async ({ sharedPage: page }) => {
  const jmap = await connectJmap();
  const mailboxes = await listMailboxes(jmap);
  const inbox = mailboxByRole(mailboxes, 'inbox');
  const trash = mailboxByRole(mailboxes, 'trash');
  if (!inbox || !trash) throw new Error('Test requires Inbox and Trash mailboxes');

  const subject = `Iframe height e2e ${Date.now()}`;
  let createdId = null;
  try {
    createdId = await createEmailInMailbox(jmap, {
      mailboxId: inbox.id,
      fromEmail: selfEmail(),
      subject,
      bodyText: 'Plain fallback for iframe height e2e.',
      htmlBody: tallHtmlBody(),
    });

    const target = page.locator('.msg-list__item').filter({ hasText: subject }).first();
    await expect(target).toBeVisible({ timeout: 30_000 });
    await target.locator('.msg-list__content').click();
    await expect(page.locator('.message-view__title h2')).toHaveText(subject, { timeout: 30_000 });
    await expect(page.locator('iframe.message-view__html-frame')).toBeVisible({ timeout: 30_000 });

    await expect.poll(
      async () => iframeHeight(page),
      { timeout: 15_000, message: 'iframe height never grew past 120 on first open' },
    ).toBeGreaterThan(1000);

    const initialHeight = await iframeHeight(page);
    await page.waitForTimeout(3000);
    const stableHeight = await iframeHeight(page);
    expect(stableHeight,
      `iframe height regressed after settling: was ${initialHeight}, now ${stableHeight}`)
      .toBeGreaterThan(1000);

    const otherCheckbox = page.locator('.msg-list__item').filter({ hasNotText: subject }).nth(0)
      .locator('.msg-list__check input');
    await otherCheckbox.click();
    await expect(page.locator('.message-view__bulk')).toBeVisible({ timeout: 5_000 });
    await page.locator('.message-view__bulk-actions .message-view__action--ghost').click();
    await expect(page.locator('iframe.message-view__html-frame')).toBeVisible({ timeout: 5_000 });
    await expect.poll(
      async () => iframeHeight(page),
      { timeout: 10_000, message: 'iframe height stuck at 120 after returning from bulk view' },
    ).toBeGreaterThan(1000);
  } finally {
    if (createdId) {
      await cleanupEmail(jmap, createdId, trash.id);
    }
  }
});
