import { deflateSync } from 'node:zlib';

import {
  connectJmap,
  destroyEmails,
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
  composeSubject,
  fillRecipient,
  waitForIdentities,
} from './helpers/compose.js';
import {
  localStackEnabled,
  selfEmail,
  skipLocalStackMessage,
} from './helpers/stack-env.js';
import {
  clickFolder,
  expectRowSoon,
  openMessageBySubject,
  waitForPendingMutations,
} from './helpers/ui.js';

test.skip(!localStackEnabled, skipLocalStackMessage);
test.use({ viewport: { width: 1440, height: 900 } });
test.setTimeout(180_000);

const SUBJECT_PREFIX = 'Attachment browser e2e';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function makePng(width = 16, height = 16) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    for (let x = 0; x < width; x += 1) {
      const pixelStart = rowStart + 1 + x * 4;
      rows.set([0x33, 0x66, 0xcc, 0xff], pixelStart);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const PNG_BYTES = makePng();
const ZIP_BYTES = Buffer.from([
  0x50, 0x4b, 0x05, 0x06,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x00,
]);
const TEXT_PREVIEW_LIMIT = 256 * 1024;
const TEXT_ATTACHMENT_BYTES = Buffer.alloc(TEXT_PREVIEW_LIMIT + 17, 0x78);
const PICKER_FILES = [
  {
    name: 'picker-one.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('first picker attachment'),
  },
  {
    name: 'picker-two.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from([0x00, 0x11, 0x22, 0x33, 0x44]),
  },
];
const PASTED_FILE = {
  name: 'pasted-report.csv',
  mimeType: 'text/csv',
  buffer: Buffer.from('name,value\nattachment,ready\n'),
};
const REGULAR_COMPOSE_FILES = [...PICKER_FILES, PASTED_FILE];

async function uploadBlob(jmap, bytes, type) {
  const advertised = jmap.session.uploadUrl;
  if (!advertised) throw new Error('JMAP session has no uploadUrl');
  const url = advertised
    .replace(new URL(advertised).origin, new URL(jmap.apiUrl).origin)
    .replace('{accountId}', encodeURIComponent(jmap.accountId));
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: jmap.authHeader,
      'Content-Type': type,
      Accept: 'application/json',
    },
    body: bytes,
  });
  if (!response.ok) {
    throw new Error(`JMAP upload failed: ${response.status} ${await response.text()}`);
  }
  const result = await response.json();
  if (!result?.blobId) throw new Error(`JMAP upload returned no blobId: ${JSON.stringify(result)}`);
  return result;
}

async function createReceivedFixtures(jmap, inbox, stamp) {
  const [image, text, archive, longArchive] = await Promise.all([
    uploadBlob(jmap, PNG_BYTES, 'image/png'),
    uploadBlob(jmap, TEXT_ATTACHMENT_BYTES, 'text/plain'),
    uploadBlob(jmap, ZIP_BYTES, 'application/zip'),
    uploadBlob(jmap, ZIP_BYTES, 'application/zip'),
  ]);
  const shortSubject = `${SUBJECT_PREFIX} received short ${stamp}`;
  const longSubject = `${SUBJECT_PREFIX} received long ${stamp}`;
  const address = selfEmail();
  const payload = await jmapRequest(jmap, [[
    'Email/set',
    {
      accountId: jmap.accountId,
      create: {
        short: {
          mailboxIds: { [inbox.id]: true },
          keywords: { $seen: true },
          from: [{ email: address }],
          to: [{ email: address }],
          subject: shortSubject,
          bodyStructure: {
            type: 'multipart/mixed',
            subParts: [
              { type: 'text/plain', partId: 'short-body' },
              {
                blobId: image.blobId,
                type: 'image/png',
                name: 'photo.png',
                disposition: 'attachment',
              },
              {
                blobId: text.blobId,
                type: 'text/plain',
                charset: 'utf-8',
                name: 'notes.txt',
                disposition: 'attachment',
              },
              {
                blobId: archive.blobId,
                type: 'application/zip',
                name: '../../CON\u202e.zip',
                disposition: 'attachment',
              },
            ],
          },
          bodyValues: {
            'short-body': { value: 'Short authored body before attachment previews.' },
          },
        },
        long: {
          mailboxIds: { [inbox.id]: true },
          keywords: { $seen: true },
          from: [{ email: address }],
          to: [{ email: address }],
          subject: longSubject,
          bodyStructure: {
            type: 'multipart/mixed',
            subParts: [
              { type: 'text/plain', partId: 'long-body' },
              {
                blobId: longArchive.blobId,
                type: 'application/zip',
                name: 'long-body.zip',
                disposition: 'attachment',
              },
            ],
          },
          bodyValues: {
            'long-body': {
              value: Array.from(
                { length: 320 },
                (_, index) => `Long authored body line ${index} ${'scroll region '.repeat(8)}`,
              ).join('\n'),
            },
          },
        },
      },
    },
    'received-fixtures',
  ]]);
  const set = pickResponse(payload, 'Email/set');
  if (set?.notCreated && Object.keys(set.notCreated).length > 0) {
    throw new Error(`Could not create attachment fixtures: ${JSON.stringify(set.notCreated)}`);
  }
  const shortId = set?.created?.short?.id;
  const longId = set?.created?.long?.id;
  if (!shortId || !longId) {
    throw new Error(`Attachment fixture create returned incomplete ids: ${JSON.stringify(set)}`);
  }
  return {
    shortId,
    longId,
    shortSubject,
    longSubject,
  };
}

async function downloadBytes(download) {
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function emailsByExactSubject(jmap, mailboxId, subject) {
  const queried = await jmapRequest(jmap, [[
    'Email/query',
    {
      accountId: jmap.accountId,
      filter: {
        operator: 'AND',
        conditions: [{ inMailbox: mailboxId }, { subject }],
      },
      sort: [{ property: 'receivedAt', isAscending: false }],
      limit: 20,
    },
    'q1',
  ]]);
  const ids = pickResponse(queried, 'Email/query')?.ids ?? [];
  if (ids.length === 0) return [];
  const fetched = await jmapRequest(jmap, [[
    'Email/get',
    {
      accountId: jmap.accountId,
      ids,
      properties: [
        'id',
        'blobId',
        'subject',
        'mailboxIds',
        'keywords',
        'bodyStructure',
        'attachments',
        'htmlBody',
        'bodyValues',
      ],
      bodyProperties: [
        'partId',
        'blobId',
        'type',
        'name',
        'size',
        'charset',
        'disposition',
        'cid',
        'subParts',
      ],
      fetchHTMLBodyValues: true,
    },
    'g1',
  ]]);
  return (pickResponse(fetched, 'Email/get')?.list ?? [])
    .filter((email) => email.subject === subject);
}

async function pasteMixedClipboardFiles(page) {
  await page.evaluate(({ pngBase64, pasted }) => {
    const editor = document.querySelector(
      '.compose-dialog--expanded .editor[contenteditable]',
    );
    if (!(editor instanceof HTMLElement)) throw new Error('Compose editor is missing');
    editor.focus();
    const binary = atob(pngBase64);
    const imageBytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      imageBytes[index] = binary.charCodeAt(index);
    }
    const transfer = new DataTransfer();
    transfer.items.add(new File([imageBytes], 'clipboard.png', { type: 'image/png' }));
    transfer.items.add(new File([pasted.text], pasted.name, { type: pasted.type }));
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: transfer });
    editor.dispatchEvent(event);
  }, {
    pngBase64: PNG_BYTES.toString('base64'),
    pasted: {
      name: PASTED_FILE.name,
      type: PASTED_FILE.mimeType,
      text: PASTED_FILE.buffer.toString('utf8'),
    },
  });
}

function normalizeServerAttachments(attachments) {
  return attachments.map((part) => ({
    partId: part.partId,
    blobId: part.blobId,
    name: part.name ?? null,
    type: part.type ?? null,
    size: part.size == null ? null : Number(part.size),
    disposition: part.disposition ?? null,
    cid: part.cid ? String(part.cid).replace(/^<|>$/g, '') : null,
  }));
}

function normalizeLocalAttachments(attachments) {
  return attachments.map((part) => ({
    partId: part.part_id,
    blobId: part.blob_id,
    name: part.name ?? null,
    type: part.mime_type ?? null,
    size: part.size == null ? null : Number(part.size),
    disposition: part.disposition ?? null,
    cid: part.cid ? String(part.cid).replace(/^<|>$/g, '') : null,
  }));
}

async function localAttachmentSnapshot(page, remoteId) {
  return page.evaluate(async (id) => {
    const accounts = await globalThis.__repo.listAccounts();
    const account = accounts[0];
    if (!account) return null;
    const message = await globalThis.__repo.getMessageByRemote(account.id, id);
    if (!message) return null;
    const body = await globalThis.__repo.getMessageBodyForDisplay(account.id, message.id);
    return {
      message: {
        remoteId: message.remote_id,
        subject: message.subject,
        hasAttachment: Number(message.has_attachment),
      },
      attachments: body?.attachments ?? null,
    };
  }, remoteId);
}

test.describe('Attachment browser coverage', () => {
  test.beforeEach(async ({ sharedPage }) => {
    await resetSharedSession(sharedPage, {
      extraSubjectPrefixes: [SUBJECT_PREFIX],
    });
  });

  test('received attachments keep adaptive layout and safe preview/download behavior', async ({
    sharedPage: page,
  }, testInfo) => {
    const jmap = await connectJmap();
    const mailboxes = await listMailboxes(jmap);
    const inbox = mailboxByRole(mailboxes, 'inbox');
    if (!inbox) throw new Error('Test requires an Inbox mailbox');
    const createdIds = [];

    try {
      const fixture = await createReceivedFixtures(jmap, inbox, Date.now());
      createdIds.push(fixture.shortId, fixture.longId);

      await expectRowSoon(page, fixture.shortSubject);
      await openMessageBySubject(page, fixture.shortSubject);

      const attachmentBar = page.getByRole('region', { name: 'Attachments' });
      await expect(attachmentBar.getByRole('listitem')).toHaveCount(3);
      const rasterRow = attachmentBar.getByRole('listitem').filter({ hasText: 'photo.png' });
      const textRow = attachmentBar.getByRole('listitem').filter({ hasText: 'notes.txt' });
      const zipRow = attachmentBar.getByRole('listitem').filter({ hasText: 'CON' });
      await expect(rasterRow).toBeVisible();
      await expect(textRow).toBeVisible();
      await expect(zipRow).toBeVisible();
      await expect(page.getByAltText('photo.png')).toBeVisible({ timeout: 30_000 });

      const shortLayout = await page.evaluate(() => {
        const article = document.querySelector('.message-view__article');
        const body = document.querySelector('.message-view__body');
        const authored = document.querySelector('.message-view__text');
        const preview = document.querySelector('.message-attachment-preview--raster');
        const bar = document.querySelector('.message-attachment-bar');
        if (!article || !body || !authored || !preview || !bar) return null;
        const articleBox = article.getBoundingClientRect();
        const bodyBox = body.getBoundingClientRect();
        const authoredBox = authored.getBoundingClientRect();
        const previewBox = preview.getBoundingClientRect();
        const barBox = bar.getBoundingClientRect();
        return {
          articleBottom: articleBox.bottom,
          bodyBottom: bodyBox.bottom,
          authoredBottom: authoredBox.bottom,
          previewTop: previewBox.top,
          barTop: barBox.top,
          barBottom: barBox.bottom,
          bodyClientHeight: body.clientHeight,
          bodyScrollHeight: body.scrollHeight,
        };
      });
      expect(shortLayout).not.toBeNull();
      expect(shortLayout.bodyScrollHeight).toBeLessThanOrEqual(shortLayout.bodyClientHeight + 2);
      expect(shortLayout.previewTop).toBeGreaterThanOrEqual(shortLayout.authoredBottom - 1);
      expect(Math.abs(shortLayout.barTop - shortLayout.bodyBottom)).toBeLessThan(2);
      expect(shortLayout.articleBottom - shortLayout.barBottom).toBeGreaterThan(40);

      await textRow.getByRole('button', { name: 'Preview notes.txt' }).click();
      const textPreview = page.getByRole('region', { name: 'Preview of notes.txt' });
      await expect(textPreview).toBeVisible();
      await expect(textPreview.getByText('Preview truncated at 256 KiB.', { exact: true }))
        .toBeVisible();
      const textMetrics = await textPreview.locator('pre').evaluate((element) => ({
        length: element.textContent?.length ?? 0,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
      }));
      expect(textMetrics.length).toBe(TEXT_PREVIEW_LIMIT);
      expect(textMetrics.scrollHeight).toBeGreaterThan(textMetrics.clientHeight);

      await expect(zipRow.getByRole('button', { name: /^Preview / })).toHaveCount(0);
      const downloadPromise = page.waitForEvent('download');
      await zipRow.getByRole('button', { name: /^Download / }).click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe('_CON.zip');
      expect(await downloadBytes(download)).toEqual(ZIP_BYTES);

      await clickFolder(page, inbox.name);
      await expectRowSoon(page, fixture.longSubject);
      await openMessageBySubject(page, fixture.longSubject);
      const longBar = page.getByRole('region', { name: 'Attachments' });
      await expect(longBar.getByRole('listitem').filter({ hasText: 'long-body.zip' }))
        .toBeVisible();

      const beforeScroll = await page.evaluate(() => {
        const article = document.querySelector('.message-view__article');
        const body = document.querySelector('.message-view__body');
        const authored = document.querySelector('.message-view__text');
        const bar = document.querySelector('.message-attachment-bar');
        if (!article || !body || !authored || !bar) return null;
        body.scrollTop = 0;
        return {
          articleClientHeight: article.clientHeight,
          articleScrollHeight: article.scrollHeight,
          articleScrollTop: article.scrollTop,
          bodyClientHeight: body.clientHeight,
          bodyScrollHeight: body.scrollHeight,
          authoredTop: authored.getBoundingClientRect().top,
          barTop: bar.getBoundingClientRect().top,
        };
      });
      expect(beforeScroll).not.toBeNull();
      expect(beforeScroll.bodyScrollHeight).toBeGreaterThan(beforeScroll.bodyClientHeight);
      expect(beforeScroll.articleScrollHeight).toBeLessThanOrEqual(
        beforeScroll.articleClientHeight + 2,
      );

      await page.locator('.message-view__body').evaluate((body) => {
        body.scrollTop = body.scrollHeight;
      });
      await expect.poll(
        async () => page.locator('.message-view__body').evaluate((body) => body.scrollTop),
        { message: 'the long authored body should own vertical scrolling' },
      ).toBeGreaterThan(0);
      const afterScroll = await page.evaluate(() => {
        const article = document.querySelector('.message-view__article');
        const body = document.querySelector('.message-view__body');
        const authored = document.querySelector('.message-view__text');
        const bar = document.querySelector('.message-attachment-bar');
        return {
          articleScrollTop: article?.scrollTop ?? -1,
          bodyScrollTop: body?.scrollTop ?? -1,
          authoredTop: authored?.getBoundingClientRect().top ?? 0,
          barTop: bar?.getBoundingClientRect().top ?? 0,
        };
      });
      expect(afterScroll.bodyScrollTop).toBeGreaterThan(0);
      expect(afterScroll.articleScrollTop).toBe(0);
      expect(afterScroll.authoredTop).toBeLessThan(beforeScroll.authoredTop);
      expect(Math.abs(afterScroll.barTop - beforeScroll.barTop)).toBeLessThan(2);
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      await destroyEmails(jmap, createdIds);
    }
  });

  test('compose picker and mixed paste survive checkpoint, restore, and send', async ({
    sharedPage: page,
  }, testInfo) => {
    const jmap = await connectJmap();
    const mailboxes = await listMailboxes(jmap);
    const drafts = mailboxByRole(mailboxes, 'drafts');
    const sent = mailboxByRole(mailboxes, 'sent');
    if (!drafts || !sent) throw new Error('Test requires Drafts and Sent mailboxes');
    const subject = `${SUBJECT_PREFIX} compose ${Date.now()}`;
    const createdIds = new Set();

    try {
      await clickFolder(page, sent.name);
      await clickFolder(page, 'Inbox');
      await page.keyboard.press('ControlOrMeta+n');
      const composer = page.locator('.compose-dialog--expanded');
      await expect(composer).toBeVisible();
      await waitForIdentities(page);
      await fillRecipient(page, 'To', selfEmail());
      await composeSubject(page).fill(subject);
      const editor = composer.getByRole('textbox', { name: 'Message body' });
      await editor.fill('Compose attachment body survives its draft checkpoint.');

      const chooserPromise = page.waitForEvent('filechooser');
      await composer.getByRole('button', { name: 'Attach files' }).click();
      const chooser = await chooserPromise;
      expect(chooser.isMultiple()).toBe(true);
      await chooser.setFiles(PICKER_FILES);

      const composeAttachments = composer.getByRole('region', { name: 'Attachments' });
      await expect(composeAttachments.locator('.compose-attachment')).toHaveCount(2);
      for (const file of PICKER_FILES) {
        await expect(composeAttachments.getByText(file.name, { exact: true })).toBeVisible();
      }
      const initialStatuses = await composeAttachments.locator('.compose-attachment')
        .evaluateAll((rows) => rows.map((row) => row.textContent ?? ''));
      expect(initialStatuses).toHaveLength(2);
      expect(initialStatuses.every((status) => /(?:\d+%|Ready)/.test(status))).toBe(true);

      await pasteMixedClipboardFiles(page);
      await expect(editor.locator('img[src^="data:image/png;base64,"]')).toHaveCount(1);
      await expect(composeAttachments.locator('.compose-attachment')).toHaveCount(3);
      await expect(composeAttachments.getByText(PASTED_FILE.name, { exact: true })).toBeVisible();
      await expect.poll(
        async () => composeAttachments.locator('.compose-attachment__meta').allTextContents(),
        {
          timeout: 30_000,
          message: 'all regular attachments should finish uploading',
        },
      ).toEqual(REGULAR_COMPOSE_FILES.map((file) => expect.stringContaining('Ready')));

      let draftEmail = null;
      await expect.poll(async () => {
        const matches = await emailsByExactSubject(jmap, drafts.id, subject);
        for (const email of matches) createdIds.add(email.id);
        draftEmail = matches[0] ?? null;
        return draftEmail?.attachments
          ?.filter((part) => part.disposition === 'attachment')
          .map((part) => part.name) ?? [];
      }, {
        timeout: 60_000,
        message: 'autosave should checkpoint all regular attachments in Drafts',
      }).toEqual(REGULAR_COMPOSE_FILES.map((file) => file.name));
      expect(draftEmail.bodyStructure?.type).toBe('multipart/mixed');
      expect(
        draftEmail.attachments.filter((part) => part.disposition === 'inline'),
      ).toHaveLength(1);
      await expect(composer.getByText(/attachments? (?:has|have) not reached the draft yet/))
        .toHaveCount(0);

      await composer.getByRole('button', { name: 'Minimize' }).click();
      await expect(page.locator('.compose-dock__title')).toHaveText(subject);
      await page.getByRole('button', { name: `Restore ${subject}` }).click();
      await expect(composer).toBeVisible();
      await expect(composeAttachments.locator('.compose-attachment')).toHaveCount(3);
      for (const file of REGULAR_COMPOSE_FILES) {
        await expect(composeAttachments.getByText(file.name, { exact: true })).toBeVisible();
      }
      await expect(editor.locator('img[src^="data:image/png;base64,"]')).toHaveCount(1);
      await expect(editor).toContainText('Compose attachment body survives its draft checkpoint.');

      await composer.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(composer).toBeHidden({ timeout: 60_000 });
      await expect(page.getByText('Message accepted for delivery.', { exact: true })).toBeVisible();
      await waitForPendingMutations(page);

      let sentEmail = null;
      await expect.poll(async () => {
        const matches = await emailsByExactSubject(jmap, sent.id, subject);
        for (const email of matches) createdIds.add(email.id);
        sentEmail = matches[0] ?? null;
        return sentEmail?.id ?? null;
      }, {
        timeout: 30_000,
        message: 'direct JMAP should expose the sent attachment message',
      }).not.toBeNull();

      const regularParts = sentEmail.attachments
        .filter((part) => part.disposition === 'attachment');
      const inlineParts = sentEmail.attachments
        .filter((part) => part.disposition === 'inline');
      expect(regularParts.map((part) => part.name))
        .toEqual(REGULAR_COMPOSE_FILES.map((file) => file.name));
      expect(inlineParts).toHaveLength(1);
      expect(inlineParts[0]).toMatchObject({ type: 'image/png' });
      expect(sentEmail.bodyStructure?.type).toBe('multipart/mixed');
      expect(sentEmail.bodyStructure?.subParts?.[0]?.type).toBe('multipart/related');

      let localSnapshot = null;
      await expect.poll(async () => {
        localSnapshot = await localAttachmentSnapshot(page, sentEmail.id);
        return localSnapshot?.attachments?.length ?? 0;
      }, {
        timeout: 30_000,
        message: 'window.__repo should expose the sent body-part metadata',
      }).toBe(sentEmail.attachments.length);
      expect(localSnapshot.message).toEqual({
        remoteId: sentEmail.id,
        subject,
        hasAttachment: 1,
      });
      expect(normalizeLocalAttachments(localSnapshot.attachments))
        .toEqual(normalizeServerAttachments(sentEmail.attachments));

      for (const part of regularParts) {
        const fixture = REGULAR_COMPOSE_FILES.find((file) => file.name === part.name);
        expect(fixture, `missing source fixture for ${part.name}`).toBeTruthy();
        const bytes = await downloadBlob(jmap, {
          blobId: part.blobId,
          type: part.type,
          name: part.name,
        });
        expect(bytes).toEqual(fixture.buffer);
      }

      expect(sentEmail.blobId).toBeTruthy();
      const rawMimeBytes = await downloadBlob(jmap, {
        blobId: sentEmail.blobId,
        type: 'message/rfc822',
        name: 'attachment-message.eml',
      });
      const rawMime = rawMimeBytes.toString('utf8').replace(/\r?\n[ \t]+/g, ' ');
      expect(rawMime).toMatch(/Content-Type:\s*multipart\/mixed/i);
      expect(rawMime).toMatch(/Content-Type:\s*multipart\/related/i);
      expect(rawMime.match(/Content-Disposition:\s*attachment\b/gi) ?? []).toHaveLength(3);
      expect(rawMime).toMatch(/Content-Disposition:\s*inline\b/i);
      for (const file of REGULAR_COMPOSE_FILES) expect(rawMime).toContain(file.name);
      expect(rawMime).toContain('Compose attachment body survives its draft checkpoint.');
    } finally {
      await attachConsoleTail(testInfo, consoleLinesFor(page));
      for (const mailbox of [drafts, sent]) {
        const leftovers = await emailsByExactSubject(jmap, mailbox.id, subject).catch(() => []);
        for (const email of leftovers) createdIds.add(email.id);
      }
      await destroyEmails(jmap, [...createdIds]);
    }
  });
});
