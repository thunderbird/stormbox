import { test, expect } from '@playwright/test';

import {
  cleanupEmail,
  connectJmap,
  createEmailInMailbox,
  jmapRequest,
  listMailboxes,
  mailboxByRole,
  pickResponse,
  sweepOrphanTestMessages,
} from './helpers/jmap-client.js';
import { loginViaOidc } from './helpers/oidc-login.js';
import { localStackEnabled, selfEmail, skipLocalStackMessage } from './helpers/stack-env.js';

test.skip(!localStackEnabled, skipLocalStackMessage);

const subjectPrefix = 'Worker reset e2e';

test.beforeEach(async () => {
  await sweepOrphanTestMessages(await connectJmap(), { subjectPrefix });
});

test('staff diagnostics measure content replies without a manual reset control', async ({ page, context }) => {
  const jmap = await connectJmap();
  const mailboxes = await listMailboxes(jmap);
  const inbox = mailboxByRole(mailboxes, 'inbox');
  const trash = mailboxByRole(mailboxes, 'trash');
  const subject = `${subjectPrefix} ${Date.now()}`;
  const body = 'Content remains available after restarting the shared worker.';
  let emailId;
  let other;
  try {
    emailId = await createEmailInMailbox(jmap, {
      mailboxId: inbox.id, fromEmail: selfEmail(), subject, bodyText: body,
    });
    await loginViaOidc(page);
    other = await context.newPage();
    await loginViaOidc(other);
    await other.waitForFunction(() => !!window.__repo);
    const before = await page.evaluate(() => window.__repo.getWorkerStatus());
    expect(await other.evaluate(() => window.__repo.getWorkerStatus())).toMatchObject({ instanceId: before.instanceId });

    const row = page.locator('.msg-list__item').filter({ hasText: subject });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();
    await expect(page.locator('.message-view')).toContainText(body);
    await expect.poll(() => page.evaluate(() => window.__repo.getMessageContentTimings().count)).toBeGreaterThan(0);

    await page.locator('[data-settings-gear]').click();
    const status = page.locator('[data-worker-status]');
    await expect(status).toBeVisible();
    await expect(status.locator('[data-worker-uptime]')).not.toHaveText('Checking…');
    await expect(status.locator('[data-worker-response]')).toContainText('round trip');
    await expect(status.locator('[data-message-latest]')).toHaveText(/\d+.*(?:ms|s)/);
    expect(await page.locator('[data-staff-settings]').evaluate((section) => (
      !!(section.querySelector('[data-refresh-beacons]').compareDocumentPosition(
        section.querySelector('[data-worker-status]'),
      ) & Node.DOCUMENT_POSITION_FOLLOWING)
    ))).toBe(true);

    await page.evaluate(() => { window.__beforeWorkerReset = true; });
    await other.evaluate(() => { window.__beforeWorkerReset = true; });
    await expect(status.locator('[data-reset-worker]')).toHaveCount(0);
    await page.evaluate(() => window.__repo.restartWorker());
    for (const tab of [page, other]) {
      await tab.waitForFunction(() => !window.__beforeWorkerReset && !!window.__repo, { timeout: 30_000 });
      await expect(tab.locator('.shell')).toBeVisible({ timeout: 30_000 });
    }
    const after = await page.evaluate(() => window.__repo.getWorkerStatus());
    expect(after.instanceId).not.toBe(before.instanceId);
    expect(await other.evaluate(() => window.__repo.getWorkerStatus())).toMatchObject({ instanceId: after.instanceId });
    expect(after.uptimeMs).toBeLessThan(30_000);

    const cached = await page.evaluate(async (remoteId) => {
      const accounts = await window.__repo.listAccounts();
      const message = await window.__repo.getMessageByRemote(accounts[0].id, remoteId);
      return message ? window.__repo.call('message.bodyRead', { messageId: message.id }) : null;
    }, emailId);
    expect(cached?.text).toContain(body);
    const payload = await jmapRequest(jmap, [[
      'Email/get', { accountId: jmap.accountId, ids: [emailId], properties: ['id', 'subject', 'mailboxIds'] }, 'get',
    ]]);
    expect(pickResponse(payload, 'Email/get')?.list).toEqual([
      expect.objectContaining({ id: emailId, subject, mailboxIds: { [inbox.id]: true } }),
    ]);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();
    await expect(page.locator('.message-view')).toContainText(body);
  } finally {
    await other?.close();
    if (emailId) await cleanupEmail(jmap, emailId, trash?.id);
  }
});
