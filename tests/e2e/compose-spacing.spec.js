import { expect, resetSharedSession, test } from './helpers/shared-session.js';
import {
  connectJmap,
  createEmailInMailbox,
  destroyEmails,
  jmapRequest,
  listMailboxes,
  mailboxByRole,
  pickResponse,
  sweepOrphanTestMessages,
} from './helpers/jmap-client.js';
import {
  clearRecipients,
  composeSendButton,
  composeSubject,
  discardCompose,
  fillRecipient,
  saveDraftAndClose,
  waitForIdentities,
} from './helpers/compose.js';
import { clickFolder, waitForPendingMutations } from './helpers/ui.js';
import {
  localStackEnabled,
  selfEmail,
  SHARED_TEST_OIDC_EMAIL,
  SHARED_TEST_OIDC_PASSWORD,
  skipLocalStackMessage,
} from './helpers/stack-env.js';

test.skip(!localStackEnabled, skipLocalStackMessage);

const PREFIX = 'Compose spacing e2e';
const HTML = '<div>Before</div><ul><li>One<ol><li>Nested</li></ol></li><li>Two</li></ul>'
  + '<blockquote><div>Quoted</div><ul><li>Quoted item</li></ul>'
  + '<blockquote><div>Nested quote</div></blockquote></blockquote><div>After</div>';

async function findMessages(jmap, subject, mailboxId) {
  const payload = await jmapRequest(jmap, [
    ['Email/query', {
      accountId: jmap.accountId,
      filter: { subject, ...(mailboxId ? { inMailbox: mailboxId } : {}) },
      limit: 100,
    }, 'query'],
    ['Email/get', {
      accountId: jmap.accountId,
      '#ids': { resultOf: 'query', name: 'Email/query', path: '/ids' },
      properties: ['id', 'subject', 'htmlBody', 'bodyValues'],
      fetchHTMLBodyValues: true,
    }, 'get'],
  ]);
  return pickResponse(payload, 'Email/get')?.list ?? [];
}

function htmlBody(message) {
  return message?.bodyValues?.[message.htmlBody?.[0]?.partId]?.value ?? '';
}

async function expectCompactHtml(page, html) {
  const blocks = await page.evaluate((value) => {
    const template = document.createElement('template');
    template.innerHTML = value;
    return [...template.content.querySelectorAll('ul,ol,blockquote')].map((block) => [
      block.style.marginTop, block.style.marginBottom,
      block.style.paddingTop, block.style.paddingBottom,
    ]);
  }, html);
  expect(blocks).toEqual(Array.from({ length: 5 }, () => ['0px', '0px', '0px', '0px']));
}

async function expectCompactEditor(editor) {
  await expect(editor.locator('ul,ol,blockquote')).toHaveCount(5);
  const spacing = await editor.locator('ul,ol,blockquote').evaluateAll((blocks) => blocks.map((block) => {
    const style = getComputedStyle(block);
    return [style.marginTop, style.marginBottom, style.paddingTop, style.paddingBottom];
  }));
  expect(spacing).toEqual(Array.from({ length: 5 }, () => ['0px', '0px', '0px', '0px']));
  expect(await editor.locator('ul').first().evaluate((block) => parseFloat(getComputedStyle(block).paddingLeft)))
    .toBeGreaterThan(0);
}

for (const source of ['paste', 'server draft']) {
  test(`nested lists and quotes from ${source} retain compact spacing through delivery`, async ({ sharedPage: page }) => {
    const sender = await connectJmap();
    const recipient = await connectJmap({
      username: SHARED_TEST_OIDC_EMAIL,
      password: SHARED_TEST_OIDC_PASSWORD,
    });
    await resetSharedSession(page, { extraSubjectPrefixes: [PREFIX] });
    await sweepOrphanTestMessages(recipient, { subjectPrefix: PREFIX });
    for (const account of [sender, recipient]) {
      await destroyEmails(account, (await findMessages(account, PREFIX)).map((message) => message.id));
    }
    const mailboxes = await listMailboxes(sender);
    const drafts = mailboxByRole(mailboxes, 'drafts');
    const sent = mailboxByRole(mailboxes, 'sent');
    const subject = `${PREFIX} ${Date.now()}`;
    const editor = page.locator('.compose-dialog--expanded .editor[contenteditable]');
    try {
      await clickFolder(page, sent.name);
      await clickFolder(page, 'Inbox');
      if (source === 'server draft') {
        await createEmailInMailbox(sender, {
          mailboxId: drafts.id, fromEmail: selfEmail(), subject,
          htmlBody: HTML, bodyText: 'Nested lists and quoted content', keywords: { $draft: true },
        });
        await clickFolder(page, drafts.name);
        await page.locator('.msg-list__item').filter({ hasText: subject }).click();
        await expectCompactEditor(editor);
        await clearRecipients(page, 'To');
        await fillRecipient(page, 'To', SHARED_TEST_OIDC_EMAIL);
      } else {
        await page.keyboard.press('c');
        await waitForIdentities(page);
        await fillRecipient(page, 'To', SHARED_TEST_OIDC_EMAIL);
        await composeSubject(page).fill(subject);
        await editor.click();
        await editor.evaluate((element, html) => {
          const event = new Event('paste', { bubbles: true, cancelable: true });
          Object.defineProperty(event, 'clipboardData', { value: {
            items: [{ kind: 'string', type: 'text/html', getAsString: (callback) => callback(html) }],
            types: ['text/html', 'text/plain'],
            getData: (type) => type === 'text/html' ? html : 'Before\nOne\nNested\nTwo\nQuoted\nQuoted item\nNested quote\nAfter',
          } });
          element.dispatchEvent(event);
        }, HTML);
        await expectCompactEditor(editor);
        await saveDraftAndClose(page);
        await expect(editor).toHaveCount(0);
        await waitForPendingMutations(page);

        let draft;
        await expect.poll(async () => {
          [draft] = await findMessages(sender, subject, drafts.id);
          return !!draft;
        }).toBe(true);
        await expectCompactHtml(page, htmlBody(draft));
        await clickFolder(page, drafts.name);
        await page.locator('.msg-list__item').filter({ hasText: subject }).click();
        await expectCompactEditor(editor);
      }
      await composeSendButton(page).click();
      await expect(editor).toHaveCount(0);
      await waitForPendingMutations(page);

      let sentMessage;
      await expect.poll(async () => {
        [sentMessage] = await findMessages(sender, subject, sent.id);
        return !!sentMessage;
      }).toBe(true);
      await expectCompactHtml(page, htmlBody(sentMessage));
      await expect.poll(() => page.evaluate(async (remoteId) => {
        const [account] = await window.__repo.listAccounts();
        const message = await window.__repo.getMessageByRemote(account.id, remoteId);
        return message?.subject;
      }, sentMessage.id)).toBe(subject);
      await clickFolder(page, sent.name);
      const row = page.locator('.msg-list__item').filter({ hasText: subject });
      await expect(row).toBeVisible();
      await row.locator('.msg-list__open').click();
      const frame = page.frameLocator('iframe.message-view__html-frame');
      await expect(frame.locator('body')).toContainText('Nested quote');
      await expect(frame.locator('ul').first()).toHaveCSS('margin-top', '0px');

      let delivered;
      await expect.poll(async () => {
        [delivered] = await findMessages(recipient, subject);
        return !!delivered;
      }, { timeout: 30_000 }).toBe(true);
      await expectCompactHtml(page, htmlBody(delivered));
    } finally {
      if (await editor.count()) await discardCompose(page);
      for (const account of [sender, recipient]) {
        await destroyEmails(account, (await findMessages(account, subject)).map((message) => message.id));
      }
    }
  });
}
