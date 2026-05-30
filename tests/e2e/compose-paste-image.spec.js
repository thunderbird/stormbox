import {
  cleanupEmail,
  connectJmap,
  downloadBlob,
  jmapRequest,
  listMailboxes,
  mailboxByRole,
  pickResponse,
} from './helpers/jmap-client.js';
import {
  attachConsoleTail,
  consoleLinesFor,
  expect,
  resetSharedSession,
  test,
} from './helpers/shared-session.js';
import {
  localStackEnabled,
  selfEmail,
  skipLocalStackMessage,
} from './helpers/stack-env.js';
import {
  clickFolder,
  waitForPendingMutations,
} from './helpers/ui.js';

/**
 * Compose paste-image (#30) — Verified Consistency triple.
 *
 * Pasting an image into the compose editor inlines it as a data: URL for
 * an instant draft; on Send, the outbox uploads the image as a JMAP blob
 * and rewrites the HTML to a cid: inline attachment. This spec drives
 * that path through the UI and asserts the sent message in:
 *   (1) the UI, after navigating to Sent,
 *   (2) the server, via Email/get — the message carries an inline
 *       image part (disposition:inline + cid) and its HTML references
 *       that cid rather than a data: URL,
 *   (3) the blob store, by downloading the inline part's blob.
 */

test.skip(!localStackEnabled, skipLocalStackMessage);

// 1x1 transparent PNG.
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function composeInput(page, label) {
  return page.locator('.compose-dialog .row')
    .filter({ hasText: new RegExp(`^${label}$`) })
    .locator('input')
    .first();
}

async function findSentMessageBySubject(jmap, sentMailbox, subject) {
  const payload = await jmapRequest(jmap, [[
    'Email/query',
    {
      accountId: jmap.accountId,
      filter: {
        operator: 'AND',
        conditions: [{ inMailbox: sentMailbox.id }, { subject }],
      },
      sort: [{ property: 'receivedAt', isAscending: false }],
      limit: 5,
    },
    'q1',
  ]]);
  const ids = pickResponse(payload, 'Email/query')?.ids ?? [];
  return ids[0] ?? null;
}

async function getInlineImageEmail(jmap, emailId) {
  const payload = await jmapRequest(jmap, [[
    'Email/get',
    {
      accountId: jmap.accountId,
      ids: [emailId],
      properties: ['attachments', 'htmlBody', 'bodyValues', 'hasAttachment', 'bodyStructure'],
      fetchHTMLBodyValues: true,
      bodyProperties: ['partId', 'blobId', 'type', 'disposition', 'cid', 'size', 'subParts'],
    },
    'g1',
  ]]);
  return pickResponse(payload, 'Email/get')?.list?.[0] ?? null;
}

// Drive Squire's real paste path: build a DataTransfer holding an image
// File and dispatch a paste event on the editor. Squire detects the
// image-only clipboard, fires 'pasteImage', and the compose component
// inlines it as a data: URL.
async function pasteImageIntoEditor(page, base64) {
  await page.evaluate((b64) => {
    const editor = document.querySelector('.compose-dialog .editor[contenteditable]');
    editor.focus();
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const file = new File([bytes], 'paste.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    // A plain Event with a defined clipboardData works across Chromium and
    // Firefox, where the ClipboardEvent constructor's clipboardData is
    // unreliable.
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: dt });
    editor.dispatchEvent(event);
  }, base64);
}

// Paste a canvas-generated image of a known size, so it renders large
// enough to click and measure (a 1x1 px image is too small to resize).
async function pasteGeneratedImage(page, width, height) {
  await page.evaluate(({ w, h }) => new Promise((resolve) => {
    const editor = document.querySelector('.compose-dialog .editor[contenteditable]');
    editor.focus();
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#3366cc';
    ctx.fillRect(0, 0, w, h);
    canvas.toBlob((blob) => {
      const file = new File([blob], 'gen.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: dt });
      editor.dispatchEvent(event);
      resolve();
    }, 'image/png');
  }), { w: width, h: height });
}

// Wait until the editor image has decoded and rendered at full size, so
// Squire's resize handles are placed over its final box before we click
// or drag (a not-yet-decoded image leaves the handles mispositioned).
async function waitForRenderedEditorImage(page, minWidth) {
  await expect.poll(
    async () => page.evaluate(() => {
      const img = document.querySelector('.compose-dialog .editor img');
      if (!img || !img.complete || !img.naturalWidth) return 0;
      return Math.round(img.getBoundingClientRect().width);
    }),
    { timeout: 10_000, message: 'pasted image should finish loading at full size' },
  ).toBeGreaterThan(minWidth);
}

test.describe('Compose paste image e2e', () => {
  test.beforeEach(async ({ sharedPage }) => {
    await resetSharedSession(sharedPage);
  });

  test('Pasted image is sent as a cid inline attachment (UI + JMAP + blob)', async ({ sharedPage: page }, testInfo) => {
    const jmap = await connectJmap();
    const mailboxes = await listMailboxes(jmap);
    const sent = mailboxByRole(mailboxes, 'sent');
    const trash = mailboxByRole(mailboxes, 'trash');
    if (!sent || !trash) {
      throw new Error(
        `Test requires Sent and Trash mailboxes; saw ${mailboxes.map((m) => `${m.name}:${m.role}`).join(', ')}`,
      );
    }

    const recipient = selfEmail();
    const subject = `Compose paste image e2e ${Date.now()}`;
    let serverId = null;
    try {
      // Warm up Sent so a mailbox-window query_view exists for the SEND
      // apply step to prepend into.
      await clickFolder(page, sent.name);
      await clickFolder(page, 'Inbox');

      await page.keyboard.press('ControlOrMeta+n');
      await expect(page.locator('.compose-dialog')).toBeVisible({ timeout: 10_000 });

      const fromSelect = page.locator('.compose-dialog select').first();
      await expect.poll(
        async () => fromSelect.locator('option').count(),
        { timeout: 30_000, message: 'identity sync should populate the From dropdown' },
      ).toBeGreaterThan(0);

      await composeInput(page, 'To').fill(recipient);
      await composeInput(page, 'Subject').fill(subject);

      const editor = page.locator('.compose-dialog .editor[contenteditable]').first();
      await editor.click();
      await page.keyboard.type('Here is a pasted image:');

      await pasteImageIntoEditor(page, PNG_BASE64);

      // The inlined image appears in the editor before send.
      await expect(editor.locator('img[src^="data:image/"]')).toHaveCount(1, { timeout: 10_000 });

      await page.locator('.compose-dialog button.primary', { hasText: /^Send$/ }).click();
      await expect(page.locator('.compose-dialog')).toBeHidden({ timeout: 30_000 });
      await waitForPendingMutations(page);

      // UI: the new message lands in Sent.
      await clickFolder(page, sent.name);
      await expect.poll(
        async () => page.locator('.msg-list__item').filter({ hasText: subject }).count(),
        { timeout: 30_000, message: `expected "${subject}" to appear in Sent` },
      ).toBeGreaterThan(0);

      // Server: the sent message carries an inline cid image.
      await expect.poll(
        async () => findSentMessageBySubject(jmap, sent, subject),
        { timeout: 30_000, message: 'JMAP Email/query should find the sent message in Sent' },
      ).not.toBeNull();
      serverId = await findSentMessageBySubject(jmap, sent, subject);

      const email = await getInlineImageEmail(jmap, serverId);
      expect(email, 'sent message should be retrievable via Email/get').not.toBeNull();

      // The inline image must be multipart/related to the HTML, otherwise
      // recipients (e.g. Thunderbird) cannot resolve the cid: reference.
      expect(email.bodyStructure?.type).toBe('multipart/related');
      const relatedParts = email.bodyStructure.subParts ?? [];
      expect(relatedParts.some((p) => p.type === 'multipart/alternative')).toBe(true);
      expect(relatedParts.some((p) => p.disposition === 'inline' && p.type?.startsWith('image/')))
        .toBe(true);

      const inlineParts = (email.attachments ?? []).filter(
        (part) => part.disposition === 'inline' && part.cid,
      );
      expect(inlineParts.length, 'sent message should have an inline image part').toBeGreaterThan(0);
      const imagePart = inlineParts[0];
      expect(imagePart.type).toMatch(/^image\//);
      expect(imagePart.blobId, 'inline image part should reference a server blob').toBeTruthy();

      // The HTML references the cid rather than a data: URL.
      const htmlPart = email.htmlBody?.[0];
      const htmlValue = htmlPart ? (email.bodyValues?.[htmlPart.partId]?.value ?? '') : '';
      expect(htmlValue).toContain(`cid:${imagePart.cid}`);
      expect(htmlValue).not.toContain('data:image');

      // Blob store: the inline image blob is actually downloadable.
      const bytes = await downloadBlob(jmap, {
        blobId: imagePart.blobId,
        type: imagePart.type,
        name: 'paste.png',
      });
      expect(bytes.length, 'downloaded inline image blob should be non-empty').toBeGreaterThan(0);

      // Reading pane: open the sent message and confirm the viewer rewrote
      // the inline cid: reference to the image's data: URL. We assert the
      // resolved src equals the exact bytes we pasted (round-tripped via
      // upload -> server blob -> authenticated download -> data: URL),
      // which proves the cid resolution end to end. Whether the browser
      // then paints that data: URL is the engine's job, not ours.
      const row = page.locator('.msg-list__item').filter({ hasText: subject }).first();
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.locator('.msg-list__content').click();
      await expect(page.locator('.message-view__title h2')).toHaveText(subject, { timeout: 30_000 });
      await expect(page.locator('iframe.message-view__html-frame')).toBeVisible({ timeout: 30_000 });

      await expect.poll(
        async () => page.evaluate(() => {
          const ifr = document.querySelector('iframe.message-view__html-frame');
          const img = ifr?.contentDocument?.querySelector('img');
          return img?.getAttribute('src') ?? '(no img)';
        }),
        { timeout: 30_000, message: 'inline cid: image should resolve to its data: URL in the reading pane' },
      ).toBe(`data:image/png;base64,${PNG_BASE64}`);
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      if (serverId) {
        await cleanupEmail(jmap, serverId, trash.id);
      }
    }
  });

  test('Pasted image shows Squire resize handles positioned over it', async ({ sharedPage: page }, testInfo) => {
    try {
      await page.keyboard.press('ControlOrMeta+n');
      await expect(page.locator('.compose-dialog')).toBeVisible({ timeout: 10_000 });
      await expect.poll(
        async () => page.locator('.compose-dialog select').first().locator('option').count(),
        { timeout: 30_000, message: 'identity sync should populate the From dropdown' },
      ).toBeGreaterThan(0);

      const editor = page.locator('.compose-dialog .editor[contenteditable]').first();
      await editor.click();
      await pasteGeneratedImage(page, 160, 100);

      const img = editor.locator('img').first();
      await expect(img).toBeVisible({ timeout: 10_000 });
      await waitForRenderedEditorImage(page, 120);

      // Clicking the image invokes Squire's built-in object resizer, which
      // appends a handle container to the editor root.
      await img.click();

      const handles = page.locator('.compose-dialog .squire-resize-handle');
      await expect.poll(
        async () => handles.count(),
        { timeout: 10_000, message: 'Squire should render resize handles on the selected image' },
      ).toBeGreaterThan(0);

      // The handle container must sit over the image. The bug this guards
      // against was a static editor root anchoring the absolutely
      // positioned container to the fixed dialog overlay instead.
      const placement = await page.evaluate(() => {
        const image = document.querySelector('.compose-dialog .editor img');
        const box = document.querySelector('.compose-dialog .squire-image-resize-container');
        if (!image || !box) return null;
        const a = image.getBoundingClientRect();
        const b = box.getBoundingClientRect();
        return {
          dTop: Math.abs(a.top - b.top),
          dLeft: Math.abs(a.left - b.left),
          dWidth: Math.abs(a.width - b.width),
          dHeight: Math.abs(a.height - b.height),
        };
      });
      expect(placement, 'resize container should exist over the image').not.toBeNull();
      expect(placement.dTop).toBeLessThan(4);
      expect(placement.dLeft).toBeLessThan(4);
      expect(placement.dWidth).toBeLessThan(4);
      expect(placement.dHeight).toBeLessThan(4);
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
    }
  });

  test('Dragging the resize handle shrinks the pasted image', async ({ sharedPage: page }, testInfo) => {
    try {
      await page.keyboard.press('ControlOrMeta+n');
      await expect(page.locator('.compose-dialog')).toBeVisible({ timeout: 10_000 });
      await expect.poll(
        async () => page.locator('.compose-dialog select').first().locator('option').count(),
        { timeout: 30_000, message: 'identity sync should populate the From dropdown' },
      ).toBeGreaterThan(0);

      const editor = page.locator('.compose-dialog .editor[contenteditable]').first();
      await editor.click();
      await pasteGeneratedImage(page, 400, 300);

      const img = editor.locator('img').first();
      await expect(img).toBeVisible({ timeout: 10_000 });
      await waitForRenderedEditorImage(page, 350);
      await img.click();

      const handles = page.locator('.compose-dialog .squire-resize-handle');
      await expect.poll(
        async () => handles.count(),
        { timeout: 10_000, message: 'image should be selected with its resize handles' },
      ).toBe(8);

      const seHandle = page.locator('.compose-dialog .squire-resize-handle-se');
      const beforeWidth = Math.round((await img.boundingBox()).width);
      // Hover the handle so the press lands on the 8px target; a cached
      // boundingBox can miss it and start a text-selection drag instead.
      await seHandle.hover();
      const hb = await seHandle.boundingBox();
      const cx = hb.x + hb.width / 2;
      const cy = hb.y + hb.height / 2;

      // Drag the bottom-right handle toward the top-left in steps, sampling
      // the image width after each step so the trace shows where (if) it
      // gets stuck.
      await page.mouse.down();
      const widths = [];
      for (let i = 1; i <= 10; i += 1) {
        await page.mouse.move(cx - i * 14, cy - i * 10, { steps: 2 });
        widths.push(Math.round((await img.boundingBox()).width));
      }
      await page.mouse.up();

      const afterWidth = Math.round((await img.boundingBox()).width);
      console.log(`[resize repro] before=${beforeWidth} steps=${JSON.stringify(widths)} after=${afterWidth}`);

      expect(afterWidth, 'dragging the handle should shrink the image substantially')
        .toBeLessThan(beforeWidth * 0.6);
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
    }
  });
});
