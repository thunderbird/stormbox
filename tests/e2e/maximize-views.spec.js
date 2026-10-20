import { discardCompose } from './helpers/compose.js';
import {
  cleanupEmail,
  connectJmap,
  createEmailInMailbox,
  listMailboxes,
  mailboxByRole,
} from './helpers/jmap-client.js';
import { expect, resetSharedSession, test } from './helpers/shared-session.js';
import { localStackEnabled, selfEmail, skipLocalStackMessage } from './helpers/stack-env.js';

test.skip(!localStackEnabled, skipLocalStackMessage);
test.use({ viewport: { width: 1440, height: 900 } });

test.beforeEach(async ({ sharedPage }) => {
  await sharedPage.setViewportSize({ width: 1440, height: 900 });
  await resetSharedSession(sharedPage, { extraSubjectPrefixes: ['Maximize views e2e'] });
});

test('composer fills the viewport and restores without replacing the editor', async ({ sharedPage: page }) => {
  await page.locator('.sidebar__compose').click();
  const dialog = page.locator('.compose-dialog--expanded');
  const card = dialog.locator('.compose-dialog__card');
  const editor = dialog.locator('.editor');
  try {
    await dialog.locator('#compose-subject').fill(`Maximize views e2e ${Date.now()}`);
    await editor.fill('Preserve this draft while changing its size.');
    await editor.evaluate((element) => {
      window.__maximizeEditor = element;
      const range = document.createRange();
      const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode();
      range.setStart(text, 8);
      range.collapse(true);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    const normal = await card.boundingBox();
    await dialog.getByRole('button', { name: 'Maximize composer', exact: true }).click();
    await expect.poll(() => card.boundingBox()).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
    expect(await editor.evaluate((element) => ({
      same: element === window.__maximizeEditor,
      focused: document.activeElement === element,
      offset: window.getSelection().anchorOffset,
    }))).toEqual({ same: true, focused: true, offset: 8 });
    await expect(editor).toHaveText('Preserve this draft while changing its size.');

    await dialog.getByRole('button', { name: 'Minimize', exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.locator('.compose-dock__restore').click();
    await expect.poll(() => card.boundingBox()).toEqual({ x: 0, y: 0, width: 1440, height: 900 });

    const restore = dialog.getByRole('button', { name: 'Restore composer', exact: true });
    await restore.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => card.boundingBox()).toEqual(normal);
    await expect(dialog.getByRole('button', { name: 'Maximize composer', exact: true })).toBeFocused();

    for (const viewport of [{ width: 800, height: 650 }, { width: 390, height: 700 }]) {
      await page.setViewportSize(viewport);
      await dialog.getByRole('button', { name: 'Maximize composer', exact: true }).click();
      await expect.poll(() => card.boundingBox()).toEqual({ x: 0, y: 0, ...viewport });
      await dialog.getByRole('button', { name: 'Restore composer', exact: true }).click();
    }
  } finally {
    await discardCompose(page);
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});

for (const html of [false, true]) {
 test(`message view restores its pane and ${html ? 'HTML' : 'text'} reading position`, async ({ sharedPage: page }) => {
  const jmap = await connectJmap();
  const mailboxes = await listMailboxes(jmap);
  const inbox = mailboxByRole(mailboxes, 'inbox');
  const trash = mailboxByRole(mailboxes, 'trash');
  if (!inbox || !trash) throw new Error('Test requires Inbox and Trash mailboxes');
  const subject = `Maximize views e2e ${Date.now()}`;
  let createdId = null;
  try {
    const paragraphs = Array.from({ length: 220 }, (_, index) =>
      `Paragraph ${index}: ${'A long reading line. '.repeat(7)}`);
    createdId = await createEmailInMailbox(jmap, {
      mailboxId: inbox.id,
      fromEmail: selfEmail(),
      subject,
      bodyText: paragraphs.join('\n'),
      htmlBody: html ? '<style>html { padding: 16px 0; border: 2px solid transparent; } body { margin: 40px; }</style><a href="https://example.org/">Reading link</a>'
        + paragraphs.map((text) => `<p>${text}</p>`).join('') : null,
    });
    const target = page.locator('.msg-list__item').filter({ hasText: subject }).first();
    await expect(target).toBeVisible({ timeout: 30_000 });
    await target.locator('.msg-list__open').click();
    const view = page.locator('.message-view');
    const body = view.locator('.message-view__body');
    const frame = view.locator('iframe');
    const text = html ? frame.contentFrame().locator('body') : view.locator('.message-view__text');
    await expect(view.locator('.message-view__title h2')).toHaveText(subject);
    await expect(text).toContainText('Paragraph 219');
    const expectHtmlFits = async () => {
      if (!html) return;
      await expect.poll(() => frame.evaluate((iframe) => {
        const last = iframe.contentDocument.querySelector('p:last-child');
        return last.getBoundingClientRect().bottom - iframe.clientHeight;
      })).toBeLessThanOrEqual(1);
    };
    await expectHtmlFits();
    await expect.poll(() => body.evaluate((element) => element.scrollHeight - element.clientHeight))
      .toBeGreaterThan(200);
    const normal = await view.boundingBox();
    const columns = page.locator('.msg-columns');
    const columnsBefore = await columns.boundingBox();
    await body.evaluate((element) => {
      window.__maximizeBody = element;
      element.scrollTop = (element.scrollHeight - element.clientHeight) * 0.5;
    });
    const progress = () => body.evaluate((element) => {
      const range = element.scrollHeight - element.clientHeight;
      return range > 0 ? element.scrollTop / range : 0;
    });
    const beforeProgress = await progress();
    const firstParagraph = () => body.evaluate((element) => {
      const iframe = element.querySelector('iframe');
      const top = element.getBoundingClientRect().top;
      const frameTop = iframe.getBoundingClientRect().top;
      const paragraph = [...iframe.contentDocument.querySelectorAll('p')].find((p) =>
        p.getBoundingClientRect().bottom + frameTop > top);
      return Number(paragraph?.textContent.match(/^Paragraph (\d+)/)?.[1]);
    });
    const beforeParagraph = html ? await firstParagraph() : null;

    await view.getByRole('button', { name: 'Maximize message view' }).click();
    await expect(page.locator('.shell')).toHaveClass(/shell--message-view-maximized/);
    await expect.poll(() => view.boundingBox()).toEqual({ x: 0, y: 0, width: 1440, height: 900 });
    expect(await body.evaluate((element) => element === window.__maximizeBody)).toBe(true);
    await expect(columns).toBeAttached();
    await expect(columns).toBeHidden();
    await expect.poll(progress).toBeGreaterThan(beforeProgress - 0.15);
    await expect.poll(progress).toBeLessThan(beforeProgress + 0.15);
    if (html) {
      await expectHtmlFits();
      await expect.poll(firstParagraph).toBeGreaterThanOrEqual(beforeParagraph - 1);
      await expect.poll(firstParagraph).toBeLessThanOrEqual(beforeParagraph + 1);
    }
    await view.getByRole('button', { name: 'Restore message view' }).click();
    await expect(page.locator('.shell')).not.toHaveClass(/shell--message-view-maximized/);
    await expect.poll(() => view.boundingBox()).toEqual(normal);
    await expect.poll(() => columns.boundingBox()).toEqual(columnsBefore);
    await expect(columns).toBeVisible();
    expect(await body.evaluate((element) => element === window.__maximizeBody)).toBe(true);
    if (html) {
      await expectHtmlFits();
      await expect.poll(firstParagraph).toBeGreaterThanOrEqual(beforeParagraph - 1);
      await expect.poll(firstParagraph).toBeLessThanOrEqual(beforeParagraph + 1);
    } else {
      await expect.poll(progress).toBeGreaterThan(beforeProgress - 0.15);
      await expect.poll(progress).toBeLessThan(beforeProgress + 0.15);
    }
    if (html) {
      await view.getByRole('button', { name: 'Maximize message view' }).click();
      await view.getByRole('button', { name: 'Restore message view' }).focus();
      await page.keyboard.press('Tab');
      await expect(body).toBeFocused();
      const readingLink = frame.contentFrame().getByRole('link', { name: 'Reading link' });
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (await readingLink.evaluate((link) => link.ownerDocument.activeElement === link)) break;
        await page.keyboard.press('Tab');
      }
      await expect(readingLink).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(view.getByRole('button', { name: 'Maximize message view' })).toBeVisible();
    }
    for (const viewport of [{ width: 800, height: 650 }, { width: 390, height: 700 }]) {
      await page.setViewportSize(viewport);
      const controls = view.locator('.message-view__header button');
      for (const control of await controls.all()) {
        await expect(control).toBeInViewport();
      }
      if (html && viewport.width === 800) {
        await body.evaluate((element) => { element.scrollTop = element.scrollHeight * 0.5; });
        const narrowParagraph = await firstParagraph();
        for (const action of ['Maximize', 'Restore']) {
          await view.getByRole('button', { name: `${action} message view` }).click();
          await expect.poll(firstParagraph).toBeGreaterThanOrEqual(narrowParagraph - 1);
          await expect.poll(firstParagraph).toBeLessThanOrEqual(narrowParagraph + 1);
        }
      }
    }
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
    if (await page.locator('.message-view__action--back').isVisible()) {
      await page.locator('.message-view__action--back').click();
    }
    if (createdId) await cleanupEmail(jmap, createdId, trash.id);
  }
});

}
