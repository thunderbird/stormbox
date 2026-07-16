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
  localStackEnabled,
  selfEmail,
  skipLocalStackMessage,
} from './helpers/stack-env.js';

test.skip(!localStackEnabled, skipLocalStackMessage);

function styledDocumentBody() {
  return `<!doctype html>
    <html class="email-root">
      <head>
        <base href="https://example.invalid/">
        <link rel="stylesheet" href="data:text/css,body%7Bdisplay:none%7D">
        <meta http-equiv="refresh" content="9999;url=about:blank">
        <style>
          body {
            background: #203040;
            margin: 0;
            padding: 0;
          }
          .content {
            box-sizing: border-box;
            width: 100%;
            max-width: 500px;
            margin: 0 auto;
            padding: 10px 20px;
          }
          .footer { background: #e8ecf3; }
        </style>
      </head>
      <body
        class="email-body"
        text="#f5f5f5"
        link="#33ccff"
        vlink="#cc99ff"
        alink="#ffcc33"
        style="font-size:14px"
        onload="document.body.dataset.onloadRan='yes'"
      >
        <script>document.body.dataset.scriptRan = 'yes'</script>
        <div class="content"><a href="https://example.invalid/message">Styled document body</a></div>
        <div class="footer"><div class="content">Styled document footer</div></div>
      </body>
    </html>`;
}

test.beforeEach(async ({ sharedPage }) => {
  await resetSharedSession(sharedPage, {
    extraSubjectPrefixes: ['Document style e2e'],
  });
});

test('preserves complete-email presentation without active document controls', async ({
  sharedPage: page,
}) => {
  const jmap = await connectJmap();
  const mailboxes = await listMailboxes(jmap);
  const inbox = mailboxByRole(mailboxes, 'inbox');
  const trash = mailboxByRole(mailboxes, 'trash');
  if (!inbox || !trash) throw new Error('Test requires Inbox and Trash mailboxes');

  const subject = `Document style e2e ${Date.now()}`;
  let createdId = null;
  try {
    createdId = await createEmailInMailbox(jmap, {
      mailboxId: inbox.id,
      fromEmail: selfEmail(),
      subject,
      bodyText: 'Plain fallback for document style e2e.',
      htmlBody: styledDocumentBody(),
    });

    const target = page.locator('.msg-list__item').filter({ hasText: subject }).first();
    await expect(target).toBeVisible({ timeout: 30_000 });
    await target.locator('.msg-list__content').click();
    await expect(page.locator('.message-view__title h2')).toHaveText(subject, { timeout: 30_000 });

    const frame = page.locator('iframe.message-view__html-frame');
    await expect(frame).toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => frame.evaluate((iframe) =>
      iframe.contentDocument?.querySelector('.footer')?.textContent ?? ''
    )).toBe('Styled document footer');

    const result = await frame.evaluate((iframe) => {
      const doc = iframe.contentDocument;
      if (!doc?.body) throw new Error('Message iframe document is unavailable');
      const content = doc.querySelector('.content');
      const footer = doc.querySelector('.footer');
      const link = doc.querySelector('.content a');
      const contentRect = content?.getBoundingClientRect();
      const bodyRect = doc.body.getBoundingClientRect();
      const styles = Array.from(doc.head.querySelectorAll('style'));
      const csp = doc.head.querySelector('meta[http-equiv="Content-Security-Policy"]');
      return {
        rootClass: doc.documentElement.className,
        bodyClass: doc.body.className,
        iframeFallback: getComputedStyle(iframe).backgroundColor,
        htmlBackground: getComputedStyle(doc.documentElement).backgroundColor,
        bodyBackground: getComputedStyle(doc.body).backgroundColor,
        bodyColor: getComputedStyle(doc.body).color,
        bodyFontSize: getComputedStyle(doc.body).fontSize,
        bodyFillsViewport: bodyRect.height >= doc.documentElement.clientHeight,
        footerBackground: footer ? getComputedStyle(footer).backgroundColor : '',
        linkColor: link ? getComputedStyle(link).color : '',
        legacyColors: {
          text: doc.body.getAttribute('text'),
          link: doc.body.getAttribute('link'),
          vlink: doc.body.getAttribute('vlink'),
          alink: doc.body.getAttribute('alink'),
        },
        contentMaxWidth: content ? getComputedStyle(content).maxWidth : '',
        contentWidth: contentRect?.width ?? 0,
        contentCentered: contentRect
          ? Math.abs((contentRect.left + contentRect.width / 2) - doc.documentElement.clientWidth / 2) < 1
          : false,
        authorStylePreserved: styles.some((style) =>
          (style.textContent ?? '').includes('.footer { background: #e8ecf3; }')),
        cspBeforeStyles: !!csp && styles.every((style) =>
          !!(csp.compareDocumentPosition(style) & Node.DOCUMENT_POSITION_FOLLOWING)),
        activeControls: doc.querySelectorAll('base, link, meta[http-equiv="refresh"], script').length,
        onloadAttribute: doc.body.hasAttribute('onload'),
        scriptRan: doc.body.dataset.scriptRan ?? '',
        onloadRan: doc.body.dataset.onloadRan ?? '',
      };
    });

    expect(result).toEqual({
      rootClass: 'email-root',
      bodyClass: 'email-body',
      iframeFallback: 'rgb(255, 255, 255)',
      htmlBackground: 'rgba(0, 0, 0, 0)',
      bodyBackground: 'rgb(32, 48, 64)',
      bodyColor: 'rgb(245, 245, 245)',
      bodyFontSize: '14px',
      bodyFillsViewport: true,
      footerBackground: 'rgb(232, 236, 243)',
      linkColor: 'rgb(51, 204, 255)',
      legacyColors: {
        text: '#f5f5f5',
        link: '#33ccff',
        vlink: '#cc99ff',
        alink: '#ffcc33',
      },
      contentMaxWidth: '500px',
      contentWidth: 500,
      contentCentered: true,
      authorStylePreserved: true,
      cspBeforeStyles: true,
      activeControls: 0,
      onloadAttribute: false,
      scriptRan: '',
      onloadRan: '',
    });
  } finally {
    if (createdId) {
      await cleanupEmail(jmap, createdId, trash.id);
    }
  }
});
