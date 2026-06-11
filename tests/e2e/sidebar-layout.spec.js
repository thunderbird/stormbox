import { test, expect } from '@playwright/test';

import {
  connectJmap,
  createEmailInMailbox,
  listMailboxes,
  mailboxByRole,
  sweepOrphanTestMessages,
} from './helpers/jmap-client.js';
import { loginViaOidc } from './helpers/oidc-login.js';
import {
  liveE2eEnabled,
  selfEmail,
  skipLiveE2eMessage,
} from './helpers/stack-env.js';
import {
  expectRowSoon,
  openMessageBySubject,
  waitForFolderTreeReady,
  waitForInboxReady,
} from './helpers/ui.js';

// temp skipping until get running, remove when ready to test this one
test.skip();

test.skip(!liveE2eEnabled, skipLiveE2eMessage);

test.describe('Sidebar layout', () => {
  test.beforeEach(async () => {
    const jmap = await connectJmap();
    await sweepOrphanTestMessages(jmap, { subjectPrefix: 'Sidebar layout e2e' });
  });

  test('keeps the New Message button inside the folder-list header at minimum width', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 700 });
    await page.addInitScript(() => {
      window.localStorage.setItem('stormbox.welcomeModalDismissed.v1', '1');
      window.localStorage.setItem(
        'stormbox.mailColumnWidths.v1',
        JSON.stringify({ folderList: 180, messageList: 360 }),
      );
    });

    await loginViaOidc(page);
    await waitForFolderTreeReady(page);
    await page.getByRole('button', { name: /show folder list/i }).click();
    await expect.poll(
      async () => page.locator('.sidebar-slot').evaluate((slot) => {
        const rect = slot.getBoundingClientRect();
        return Math.round(rect.left);
      }),
      { timeout: 5_000, message: 'expected mobile folder overlay to finish opening' },
    ).toBe(0);
    await expect.poll(
      async () => page.locator('.sidebar-slot').evaluate((slot) => slot.getBoundingClientRect().width),
      { timeout: 5_000, message: 'expected mobile folder overlay to keep a usable width' },
    ).toBeGreaterThan(150);

    const metrics = await page.locator('.sidebar__header').evaluate((header) => {
      const slot = header.closest('.sidebar-slot');
      const button = header.querySelector('.sidebar__compose');
      if (!slot || !button) {
        throw new Error('New Message button or folder-list slot was not rendered');
      }

      const slotRect = slot.getBoundingClientRect();
      const headerRect = header.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      const headerStyles = getComputedStyle(header);
      const paddingLeft = Number.parseFloat(headerStyles.paddingLeft) || 0;
      const paddingRight = Number.parseFloat(headerStyles.paddingRight) || 0;
      const contentLeft = headerRect.left + paddingLeft;
      const contentRight = headerRect.right - paddingRight;

      return {
        buttonLeft: buttonRect.left,
        buttonRight: buttonRect.right,
        buttonWidth: buttonRect.width,
        headerLeft: headerRect.left,
        headerRight: headerRect.right,
        headerWidth: headerRect.width,
        contentLeft,
        contentRight,
        contentWidth: contentRight - contentLeft,
        slotLeft: slotRect.left,
        slotRight: slotRect.right,
        slotWidth: slotRect.width,
      };
    });
    const pixelTolerance = 0.5;

    expect(
      metrics.buttonLeft,
      `New Message button should not escape the header content on the left: ${JSON.stringify(metrics)}`,
    ).toBeGreaterThanOrEqual(metrics.contentLeft - pixelTolerance);
    expect(
      metrics.buttonRight,
      `New Message button should not escape the header content on the right: ${JSON.stringify(metrics)}`,
    ).toBeLessThanOrEqual(metrics.contentRight + pixelTolerance);
    expect(
      metrics.buttonWidth,
      `New Message button should not be wider than its header content: ${JSON.stringify(metrics)}`,
    ).toBeLessThanOrEqual(metrics.contentWidth + pixelTolerance);
    expect(
      metrics.headerRight,
      `Folder-list header should not be wider than the visible folder-list slot: ${JSON.stringify(metrics)}`,
    ).toBeLessThanOrEqual(metrics.slotRight + pixelTolerance);
    expect(
      metrics.buttonRight,
      `New Message button should not be clipped by the visible folder-list slot: ${JSON.stringify(metrics)}`,
    ).toBeLessThanOrEqual(metrics.slotRight + pixelTolerance);
  });

  test('keeps the spaces rail bottom actions inside the dynamic viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 700 });
    await page.addInitScript(() => {
      window.localStorage.setItem('stormbox.welcomeModalDismissed.v1', '1');
    });

    await loginViaOidc(page);
    await waitForFolderTreeReady(page);

    const metrics = await page.evaluate(() => {
      const shell = document.querySelector('.shell');
      const spaces = document.querySelector('.app-spaces');
      const toggle = document.querySelector('[aria-label="Show folder list"], [aria-label="Hide folder list"]');
      const mail = document.querySelector('[aria-label="Mail"]');
      const contacts = document.querySelector('[aria-label="Contacts"]');
      if (!shell || !spaces || !toggle || !mail || !contacts) {
        throw new Error('Expected shell, spaces bar, and spaces actions to be rendered');
      }

      const shellRect = shell.getBoundingClientRect();
      const spacesRect = spaces.getBoundingClientRect();
      const toggleRect = toggle.getBoundingClientRect();
      const mailRect = mail.getBoundingClientRect();
      const contactsRect = contacts.getBoundingClientRect();
      const viewportHeightToken = getComputedStyle(document.documentElement)
        .getPropertyValue('--app-viewport-height')
        .trim();
      return {
        supportsDynamicViewport: CSS.supports('height', '100dvh'),
        viewportHeightToken,
        viewportHeight: window.innerHeight,
        visualViewportHeight: window.visualViewport?.height ?? window.innerHeight,
        shellBottom: shellRect.bottom,
        spacesLeft: spacesRect.left,
        spacesRight: spacesRect.right,
        spacesBottom: spacesRect.bottom,
        spacesCenter: spacesRect.left + spacesRect.width / 2,
        toggleLeft: toggleRect.left,
        toggleBottom: toggleRect.bottom,
        actionsCenter: (mailRect.left + contactsRect.right) / 2,
      };
    });
    const pixelTolerance = 0.5;

    if (metrics.supportsDynamicViewport) {
      expect(metrics.viewportHeightToken).toBe('100dvh');
    }
    expect(
      metrics.shellBottom,
      `App shell should fit within the visible viewport: ${JSON.stringify(metrics)}`,
    ).toBeLessThanOrEqual(metrics.visualViewportHeight + pixelTolerance);
    expect(
      metrics.spacesBottom,
      `Spaces bar should sit at the bottom of the visible viewport: ${JSON.stringify(metrics)}`,
    ).toBeLessThanOrEqual(metrics.visualViewportHeight + pixelTolerance);
    expect(
      metrics.toggleBottom,
      `Folder-list toggle should remain visible in the bottom-left spaces bar: ${JSON.stringify(metrics)}`,
    ).toBeLessThanOrEqual(metrics.visualViewportHeight + pixelTolerance);
    expect(
      metrics.toggleLeft,
      `Folder-list toggle should be anchored at the bottom-left: ${JSON.stringify(metrics)}`,
    ).toBeLessThanOrEqual(16 + pixelTolerance);
    expect(
      Math.abs(metrics.actionsCenter - metrics.spacesCenter),
      `Mail and Contacts actions should be centered in the bottom spaces bar: ${JSON.stringify(metrics)}`,
    ).toBeLessThanOrEqual(8);
  });

  test('does not show the folder-list toggle or drawer in Contacts', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 700 });
    await page.addInitScript(() => {
      window.localStorage.setItem('stormbox.welcomeModalDismissed.v1', '1');
    });

    await loginViaOidc(page);
    await waitForFolderTreeReady(page);
    await page.getByRole('button', { name: /^contacts$/i }).click();
    await expect(page.locator('.contacts')).toBeVisible();
    await expect(page.locator('.sidebar-slot')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /folder list/i })).toHaveCount(0);
  });

  test('keeps the 640px boundary in a two-pane mail layout without clipping', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 852 });
    await page.addInitScript(() => {
      window.localStorage.setItem('stormbox.welcomeModalDismissed.v1', '1');
      window.localStorage.setItem(
        'stormbox.mailColumnWidths.v1',
        JSON.stringify({ folderList: 180, messageList: 360 }),
      );
    });

    await loginViaOidc(page);
    await waitForInboxReady(page);
    await page.locator('.msg-list__item').first().click();
    await expect(page.locator('.message-view')).toBeVisible();
    await expect(page.locator('.msg-list')).toBeVisible();

    const metrics = await page.locator('.shell').evaluate((shell) => {
      const list = shell.querySelector('.msg-list');
      const view = shell.querySelector('.message-view');
      if (!list || !view) {
        throw new Error('Expected message list and message view to be rendered');
      }

      const shellRect = shell.getBoundingClientRect();
      const listRect = list.getBoundingClientRect();
      const viewRect = view.getBoundingClientRect();
      return {
        shellClientWidth: shell.clientWidth,
        shellScrollWidth: shell.scrollWidth,
        shellRight: shellRect.right,
        listRight: listRect.right,
        viewLeft: viewRect.left,
        viewRight: viewRect.right,
        viewWidth: viewRect.width,
      };
    });
    const pixelTolerance = 0.5;

    expect(
      metrics.shellScrollWidth,
      `Two-pane compact layout should not force shell overflow: ${JSON.stringify(metrics)}`,
    ).toBeLessThanOrEqual(metrics.shellClientWidth + pixelTolerance);
    expect(
      metrics.listRight,
      `Message list and message view should not overlap: ${JSON.stringify(metrics)}`,
    ).toBeLessThanOrEqual(metrics.viewLeft + pixelTolerance);
    expect(
      metrics.viewRight,
      `Message view should not be clipped by the shell edge: ${JSON.stringify(metrics)}`,
    ).toBeLessThanOrEqual(metrics.shellRight + pixelTolerance);
    expect(
      metrics.viewWidth,
      `Message view should retain compact two-pane width: ${JSON.stringify(metrics)}`,
    ).toBeGreaterThan(220);
  });

  test('lets the message view fill the single-column layout below 640px', async ({ page }) => {
    await page.setViewportSize({ width: 639, height: 852 });
    await page.addInitScript(() => {
      window.localStorage.setItem('stormbox.welcomeModalDismissed.v1', '1');
      window.localStorage.setItem(
        'stormbox.mailColumnWidths.v1',
        JSON.stringify({ folderList: 180, messageList: 360 }),
      );
    });

    await loginViaOidc(page);
    await waitForInboxReady(page);
    await page.locator('.msg-list__item').first().click();
    await expect(page.locator('.message-view')).toBeVisible();
    await expect(page.locator('.msg-list')).toHaveCount(0);

    const metrics = await page.locator('.shell').evaluate((shell) => {
      const spaces = shell.querySelector('.app-spaces');
      const view = shell.querySelector('.message-view');
      if (!spaces || !view) {
        throw new Error('Expected spaces bar and message view to be rendered');
      }

      const shellRect = shell.getBoundingClientRect();
      const spacesRect = spaces.getBoundingClientRect();
      const viewRect = view.getBoundingClientRect();
      return {
        availableLeft: shellRect.left,
        availableRight: shellRect.right,
        availableBottom: spacesRect.top,
        availableWidth: shellRect.width,
        viewLeft: viewRect.left,
        viewRight: viewRect.right,
        viewBottom: viewRect.bottom,
        viewWidth: viewRect.width,
      };
    });
    const pixelTolerance = 0.5;

    expect(
      metrics.viewLeft,
      `Message view should start after the spaces rail: ${JSON.stringify(metrics)}`,
    ).toBeLessThanOrEqual(metrics.availableLeft + pixelTolerance);
    expect(
      metrics.viewRight,
      `Message view should reach the viewport edge: ${JSON.stringify(metrics)}`,
    ).toBeGreaterThanOrEqual(metrics.availableRight - pixelTolerance);
    expect(
      metrics.viewWidth,
      `Message view should fill all available single-column width: ${JSON.stringify(metrics)}`,
    ).toBeGreaterThanOrEqual(metrics.availableWidth - pixelTolerance);
    expect(
      metrics.viewBottom,
      `Message view should stop above the bottom spaces bar: ${JSON.stringify(metrics)}`,
    ).toBeLessThanOrEqual(metrics.availableBottom + pixelTolerance);
  });

  test('keeps the message view from causing page overflow below 300px column width', async ({ page }) => {
    await page.setViewportSize({ width: 340, height: 852 });
    await page.addInitScript(() => {
      window.localStorage.setItem('stormbox.welcomeModalDismissed.v1', '1');
      window.localStorage.setItem(
        'stormbox.mailColumnWidths.v1',
        JSON.stringify({ folderList: 180, messageList: 360 }),
      );
    });

    await loginViaOidc(page);
    await waitForInboxReady(page);
    await page.locator('.msg-list__item').first().click();
    await expect(page.locator('.message-view')).toBeVisible();
    await expect(page.locator('.msg-list')).toHaveCount(0);

    const metrics = await page.evaluate(() => {
      const shell = document.querySelector('.shell');
      const spaces = document.querySelector('.app-spaces');
      const view = document.querySelector('.message-view');
      const article = document.querySelector('.message-view__article');
      const body = document.querySelector('.message-view__body');
      const frame = document.querySelector('iframe.message-view__html-frame');
      let frameDocumentScrollWidth = 0;
      let frameDocumentClientWidth = 0;
      if (frame?.contentDocument) {
        frameDocumentScrollWidth = Math.max(
          frame.contentDocument.documentElement?.scrollWidth ?? 0,
          frame.contentDocument.body?.scrollWidth ?? 0,
        );
        frameDocumentClientWidth = Math.max(
          frame.contentDocument.documentElement?.clientWidth ?? 0,
          frame.contentDocument.body?.clientWidth ?? 0,
        );
      }
      if (!shell || !spaces || !view || !article || !body) {
        throw new Error('Expected shell, spaces bar, message view, article, and body to be rendered');
      }

      const viewRect = view.getBoundingClientRect();
      const articleRect = article.getBoundingClientRect();
      return {
        viewportWidth: window.innerWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        shellClientWidth: shell.clientWidth,
        shellScrollWidth: shell.scrollWidth,
        expectedColumnWidth: shell.clientWidth,
        viewWidth: viewRect.width,
        articleWidth: articleRect.width,
        bodyClientWidth: body.clientWidth,
        bodyScrollWidth: body.scrollWidth,
        frameDocumentClientWidth,
        frameDocumentScrollWidth,
      };
    });
    const pixelTolerance = 0.5;

    expect(
      metrics.documentScrollWidth,
      `Message view should not force document-level horizontal overflow: ${JSON.stringify(metrics)}`,
    ).toBeLessThanOrEqual(metrics.viewportWidth + pixelTolerance);
    expect(
      metrics.shellScrollWidth,
      `Message view should not force shell-level horizontal overflow: ${JSON.stringify(metrics)}`,
    ).toBeLessThanOrEqual(metrics.shellClientWidth + pixelTolerance);
    expect(
      metrics.viewWidth,
      `Message view should keep shrinking with the available column: ${JSON.stringify(metrics)}`,
    ).toBeLessThanOrEqual(metrics.expectedColumnWidth + pixelTolerance);
    expect(
      metrics.articleWidth,
      `Message article should not preserve a wider intrinsic width: ${JSON.stringify(metrics)}`,
    ).toBeLessThanOrEqual(metrics.viewWidth + pixelTolerance);
    expect(
      metrics.bodyScrollWidth,
      `Message body should not develop horizontal scrolling: ${JSON.stringify(metrics)}`,
    ).toBeLessThanOrEqual(metrics.bodyClientWidth + pixelTolerance);
    if (metrics.frameDocumentClientWidth > 0) {
      expect(
        metrics.frameDocumentScrollWidth,
        `HTML message iframe should not develop horizontal scrolling: ${JSON.stringify(metrics)}`,
      ).toBeLessThanOrEqual(metrics.frameDocumentClientWidth + pixelTolerance);
    }
  });

  test('wraps long message metadata instead of truncating with ellipses', async ({ page }) => {
    const jmap = await connectJmap();
    const mailboxes = await listMailboxes(jmap);
    const inbox = mailboxByRole(mailboxes, 'inbox');
    if (!inbox) throw new Error('Test requires Inbox mailbox');

    const stamp = Date.now();
    const subject = `Sidebar layout e2e ${stamp} exceptionally long subject that should wrap instead of truncating`;
    await createEmailInMailbox(jmap, {
      mailboxId: inbox.id,
      fromEmail: `very.long.sender.name.with.many.parts.${stamp}@example-long-domain.test`,
      subject,
      bodyText: 'Long metadata wrapping regression body.',
    });

    await page.setViewportSize({ width: 639, height: 852 });
    await page.addInitScript(() => {
      window.localStorage.setItem('stormbox.welcomeModalDismissed.v1', '1');
      window.localStorage.setItem(
        'stormbox.mailColumnWidths.v1',
        JSON.stringify({ folderList: 180, messageList: 360 }),
      );
    });

    await loginViaOidc(page);
    await openMessageBySubject(page, subject);

    const metrics = await page.locator('.message-view__metadata').evaluate((metadata) => {
      const fromValue = metadata.querySelector('.message-view__metadata-row:nth-child(1) dd');
      const subjectHeading = metadata.querySelector('.message-view__title h2');
      if (!fromValue || !subjectHeading) {
        throw new Error('Expected From and Subject metadata to be rendered');
      }

      const fromStyles = getComputedStyle(fromValue);
      const subjectStyles = getComputedStyle(subjectHeading);
      return {
        fromText: fromValue.textContent,
        subjectText: subjectHeading.textContent,
        fromWhiteSpace: fromStyles.whiteSpace,
        subjectWhiteSpace: subjectStyles.whiteSpace,
        fromOverflowWrap: fromStyles.overflowWrap,
        subjectOverflowWrap: subjectStyles.overflowWrap,
        fromHeight: fromValue.getBoundingClientRect().height,
        subjectHeight: subjectHeading.getBoundingClientRect().height,
      };
    });

    expect(metrics.fromText).not.toContain('…');
    expect(metrics.subjectText).toBe(subject);
    expect(metrics.fromWhiteSpace).toBe('normal');
    expect(metrics.subjectWhiteSpace).toBe('normal');
    expect(metrics.fromOverflowWrap).toBe('anywhere');
    expect(metrics.subjectOverflowWrap).toBe('anywhere');
    expect(metrics.subjectHeight).toBeGreaterThan(16);
  });

  test('keeps read card subjects normal weight while unread card subjects are bold', async ({ page }) => {
    const jmap = await connectJmap();
    const mailboxes = await listMailboxes(jmap);
    const inbox = mailboxByRole(mailboxes, 'inbox');
    if (!inbox) throw new Error('Test requires Inbox mailbox');

    const stamp = Date.now();
    const readSubject = `Sidebar layout e2e ${stamp} read card row`;
    const unreadSubject = `Sidebar layout e2e ${stamp} unread card row`;
    await createEmailInMailbox(jmap, {
      mailboxId: inbox.id,
      fromEmail: selfEmail(),
      subject: readSubject,
      bodyText: 'Read card weight regression body.',
      keywords: { $seen: true },
    });
    await createEmailInMailbox(jmap, {
      mailboxId: inbox.id,
      fromEmail: selfEmail(),
      subject: unreadSubject,
      bodyText: 'Unread card weight regression body.',
      keywords: {},
    });

    await page.setViewportSize({ width: 640, height: 852 });
    await page.addInitScript(() => {
      window.localStorage.setItem('stormbox.welcomeModalDismissed.v1', '1');
      window.localStorage.setItem(
        'stormbox.mailColumnWidths.v1',
        JSON.stringify({ folderList: 180, messageList: 360 }),
      );
    });

    await loginViaOidc(page);
    await waitForFolderTreeReady(page);
    await expectRowSoon(page, readSubject);
    await expectRowSoon(page, unreadSubject);
    await page.locator('.msg-list__item').filter({ hasText: readSubject }).first().click();
    await expect(page.locator('.message-view')).toBeVisible();
    await expect(page.locator('.msg-list')).toHaveClass(/msg-list--card/);

    const cardMetrics = await page.evaluate(({ read, unread }) => {
      const rows = Array.from(document.querySelectorAll('.msg-list__item'));
      const readRow = rows.find((row) => row.textContent?.includes(read));
      const unreadRow = rows.find((row) => row.textContent?.includes(unread));
      const readSubjectEl = readRow?.querySelector('.msg-list__subject');
      const unreadSubjectEl = unreadRow?.querySelector('.msg-list__subject');
      const readPreviewEl = readRow?.querySelector('.msg-list__preview');
      if (!readSubjectEl || !unreadSubjectEl || !readPreviewEl) {
        throw new Error('Expected read and unread card content to be rendered');
      }
      const readSubjectStyles = getComputedStyle(readSubjectEl);
      const readPreviewStyles = getComputedStyle(readPreviewEl);
      return {
        readWeight: Number(readSubjectStyles.fontWeight),
        unreadWeight: Number(getComputedStyle(unreadSubjectEl).fontWeight),
        subjectClamp: readSubjectStyles.getPropertyValue('-webkit-line-clamp'),
        subjectWhiteSpace: readSubjectStyles.whiteSpace,
        previewClamp: readPreviewStyles.getPropertyValue('-webkit-line-clamp'),
      };
    }, { read: readSubject, unread: unreadSubject });

    expect(cardMetrics.readWeight).toBeLessThan(600);
    expect(cardMetrics.unreadWeight).toBeGreaterThanOrEqual(600);
    expect(cardMetrics.subjectClamp).toBe('2');
    expect(cardMetrics.subjectWhiteSpace).toBe('normal');
    expect(cardMetrics.previewClamp).toBe('1');
  });
});
