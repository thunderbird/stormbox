import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';

import { DB_RPC } from '../../src/db/protocol';
import { fetchEmailBodies } from '../../src/sync/backends/jmap/bodies';
import { syncIdentities } from '../../src/sync/backends/jmap/identities';
import { syncMailboxes } from '../../src/sync/backends/jmap/mailboxes';
import {
  EMAIL_LIST_PROPERTIES,
  persistEmails,
} from '../../src/sync/backends/jmap/messages';
import { MUTATION_TYPES } from '../../src/sync/backends/jmap/outbox';
import { makeMessageId, makeOperationId } from '../../src/utils/message-id';
import {
  SHARED_TEST_OIDC_EMAIL,
  SHARED_TEST_OIDC_PASSWORD,
} from '../e2e/helpers/stack-env';
import {
  callMethod,
  createLiveMailIntegrationContext,
  createLiveTransport,
  MAIL_USING,
  processInsertedMutation,
  refreshLiveMailSession,
} from './helpers/live-jmap';
import {
  destroyEmails,
  destroyEmailsWithSubjectPrefix,
  type LiveMailAccount,
  liveMailAccount,
  mailboxByRole,
  remoteEmail,
  remoteMailboxes,
  waitForEmailBySubject,
} from './helpers/live-mail';

const PNG_BYTES = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='),
  (character) => character.charCodeAt(0),
);
const PDF_BYTES = new TextEncoder().encode('%PDF-1.1\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

function attachmentLeaves(part: any): any[] {
  if (!part || typeof part !== 'object') return [];
  if (Array.isArray(part.subParts) && part.subParts.length > 0) {
    return part.subParts.flatMap(attachmentLeaves);
  }
  const type = String(part.type ?? '');
  if (type.startsWith('multipart/')) return [];
  if (part.disposition === 'attachment' || part.name) return [part];
  return [];
}

function bytesOf(blob: Blob): Promise<Uint8Array> {
  return blob.arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

/** Subject and mailbox-name prefix shared by every run of this suite; sweeps match on it. */
const SUBJECT_FAMILY = 'Stormbox attach ';

describe.sequential('live Stalwart attachment transfer', () => {
  /** This run's names; assertions match on it so other runs' leftovers cannot satisfy them. */
  const prefix = `${SUBJECT_FAMILY}${randomUUID()}`;
  let context: Awaited<ReturnType<typeof createLiveMailIntegrationContext>>;
  /** The integration account as seen through its own transport. */
  let mail: LiveMailAccount;
  /** Recipient and share owner on a second principal. */
  let owner: Awaited<ReturnType<typeof createLiveTransport>>;
  let draftsFolder: any;
  let sentFolder: any;
  let identity: any;
  const createdEmailIds = new Set<string>();
  const ownerEmailIds = new Set<string>();
  const ownerMailboxIds = new Set<string>();

  /** Owner mailboxes this run tracked plus any left by an earlier run. */
  async function destroyOwnerMailboxes() {
    const swept = (await remoteMailboxes(owner))
      .filter((mailbox: any) => String(mailbox.name ?? '').startsWith(SUBJECT_FAMILY))
      .map((mailbox: any) => mailbox.id);
    const ids = [...new Set([...ownerMailboxIds, ...swept])];
    if (ids.length === 0) return;
    await callMethod(owner.transport, MAIL_USING, 'Mailbox/set', {
      accountId: owner.accountId,
      destroy: ids,
      onDestroyRemoveEmails: true,
    }, 'destroy-mailboxes');
    ownerMailboxIds.clear();
  }

  /**
   * This run's tracked emails by id, then every message and mailbox
   * carrying the family prefix, so an interrupted run's leftovers go on
   * the next start rather than accumulating.
   */
  async function cleanupFamilyMail() {
    if (!context) return;
    await destroyEmails(mail, [...createdEmailIds]);
    createdEmailIds.clear();
    for (const role of ['inbox', 'drafts', 'sent'] as const) {
      try {
        const mailbox = await mailboxByRole(mail, role);
        await destroyEmailsWithSubjectPrefix(mail, mailbox.id, SUBJECT_FAMILY);
      } catch {
        // Role mailbox may be missing during a failed beforeAll.
      }
    }
    if (owner) {
      await destroyEmails(owner, [...ownerEmailIds]);
      ownerEmailIds.clear();
      try {
        const inbox = await mailboxByRole(owner, 'inbox');
        await destroyEmailsWithSubjectPrefix(owner, inbox.id, SUBJECT_FAMILY);
      } catch {
        // Owner inbox cleanup is best-effort before mailbox destroy.
      }
      await destroyOwnerMailboxes();
    }
  }

  /**
   * Rows stay in pending_mutations after the run: this suite never
   * drains by status, and the failing-blob case inspects the outcome.
   */
  function runMutation(mutationType: string, request: Record<string, unknown>) {
    return processInsertedMutation(context, {
      mutationType,
      request,
      deleteOnSuccess: false,
    });
  }

  function draftRequest(
    revision: number,
    fields: Record<string, unknown>,
  ) {
    return {
      operationId: makeOperationId(),
      draftSessionId: fields.draftSessionId,
      revision,
      revisionMessageId: makeMessageId(identity.email),
      payloadHash: `${revision}-${randomUUID()}`,
      identityId: identity.id,
      to: [{ email: SHARED_TEST_OIDC_EMAIL }],
      cc: [],
      bcc: [],
      subject: fields.subject,
      textBody: fields.textBody,
      htmlBody: fields.htmlBody ?? '',
      attachments: fields.attachments ?? [],
      inReplyTo: [],
      references: [],
      draftsFolderId: draftsFolder.id,
      draftEmailIds: fields.draftEmailIds ?? [],
    };
  }

  /** Cache `emailId` from `account` (possibly shared) via the sharee's transport. */
  async function persistRemoteEmail(account: any, emailId: string) {
    const listed = await remoteEmail(
      liveMailAccount({ transport: context.transport, account }),
      emailId,
      EMAIL_LIST_PROPERTIES,
    );
    if (!listed) {
      throw new Error(`Email/get list properties missed ${emailId}`);
    }
    await persistEmails({ account, emails: [listed], handlers: context.handlers });
    await fetchEmailBodies({
      transport: context.transport,
      account,
      handlers: context.handlers,
      remoteIds: [emailId],
    });
    return context.handlers[DB_RPC.MESSAGE_GET_BY_REMOTE]({
      accountId: account.id,
      remoteId: emailId,
    });
  }

  beforeAll(async () => {
    context = await createLiveMailIntegrationContext();
    mail = liveMailAccount(context);
    owner = await createLiveTransport({
      email: SHARED_TEST_OIDC_EMAIL,
      password: SHARED_TEST_OIDC_PASSWORD,
    });
    await cleanupFamilyMail();
    await syncMailboxes({
      transport: context.transport,
      account: context.account,
      handlers: context.handlers,
    });
    await syncIdentities({
      transport: context.transport,
      account: context.account,
      handlers: context.handlers,
    });
    draftsFolder = await context.handlers[DB_RPC.FOLDER_BY_ROLE]({
      accountId: context.account.id,
      role: 'drafts',
    });
    sentFolder = await context.handlers[DB_RPC.FOLDER_BY_ROLE]({
      accountId: context.account.id,
      role: 'sent',
    });
    const identities = await context.handlers[DB_RPC.IDENTITY_LIST]({
      accountId: context.account.id,
    });
    identity = identities[0];
    if (!draftsFolder || !sentFolder || !identity) {
      throw new Error('Integration mail account is missing Drafts, Sent, or an Identity');
    }
  });

  afterAll(async () => {
    try {
      await cleanupFamilyMail();
    } finally {
      await context?.engine.close();
    }
  });

  it('reads received attachment metadata, bytes, MIME order, and shared-account routing', async () => {
    const mailboxName = `${prefix} shared`;
    const created = (await callMethod(owner.transport, MAIL_USING, 'Mailbox/set', {
      accountId: owner.accountId,
      create: { live: { name: mailboxName, isSubscribed: true } },
    }, 'create-shared')).created?.live;
    if (!created?.id) throw new Error('Owner Mailbox/set returned no mailbox id');
    ownerMailboxIds.add(created.id);

    const shared = await callMethod(owner.transport, MAIL_USING, 'Mailbox/set', {
      accountId: owner.accountId,
      update: {
        [created.id]: {
          shareWith: {
            [context.account.remote_account_id]: {
              mayReadItems: true,
              mayAddItems: true,
              mayRemoveItems: true,
              maySetSeen: true,
              maySetKeywords: true,
              mayCreateChild: true,
              mayRename: true,
              mayDelete: true,
              maySubmit: false,
            },
          },
        },
      },
    }, 'share');
    if (shared.notUpdated?.[created.id]) {
      throw new Error(`Mailbox share failed: ${JSON.stringify(shared.notUpdated[created.id])}`);
    }

    await refreshLiveMailSession(context);
    const sharedAccount = context.sharedAccounts.find(
      (account) => account.remote_account_id === owner.accountId,
    );
    if (!sharedAccount) {
      throw new Error('Shared owner account did not appear in the sharee JMAP Session');
    }
    await callMethod(context.transport, MAIL_USING, 'Mailbox/set', {
      accountId: owner.accountId,
      update: { [created.id]: { isSubscribed: true } },
    }, 'subscribe');
    await syncMailboxes({
      transport: context.transport,
      account: sharedAccount,
      handlers: context.handlers,
      repairArchive: false,
    });

    const pngUpload = await owner.transport.upload({
      accountId: owner.accountId,
      type: 'image/png',
      body: PNG_BYTES,
    });
    const pdfUpload = await owner.transport.upload({
      accountId: owner.accountId,
      type: 'application/pdf',
      body: PDF_BYTES,
    });
    const subject = `${prefix} received`;
    const seeded = (await callMethod(owner.transport, MAIL_USING, 'Email/set', {
      accountId: owner.accountId,
      create: {
        received: {
          mailboxIds: { [created.id]: true },
          from: [{ email: SHARED_TEST_OIDC_EMAIL }],
          to: [{ email: SHARED_TEST_OIDC_EMAIL }],
          subject,
          bodyStructure: {
            type: 'multipart/mixed',
            subParts: [
              {
                type: 'multipart/alternative',
                subParts: [
                  { type: 'text/plain', partId: 'p1' },
                  { type: 'text/html', partId: 'h1' },
                ],
              },
              {
                blobId: pngUpload.blobId,
                type: 'image/png',
                name: 'photo.png',
                disposition: 'attachment',
              },
              {
                blobId: pdfUpload.blobId,
                type: 'application/pdf',
                name: 'doc.pdf',
                disposition: 'attachment',
              },
            ],
          },
          bodyValues: {
            p1: { value: 'See attachments' },
            h1: { value: '<p>See attachments</p>' },
          },
        },
      },
    }, 'seed-received')).created?.received;
    if (!seeded?.id) throw new Error('Owner Email/set returned no id');
    ownerEmailIds.add(seeded.id);

    const remote = await remoteEmail(owner, seeded.id);
    expect(remote).toMatchObject({ hasAttachment: true });
    expect(attachmentLeaves(remote.bodyStructure).map((part) => part.name))
      .toEqual(['photo.png', 'doc.pdf']);

    const local = await persistRemoteEmail(sharedAccount, seeded.id);
    expect(local).toMatchObject({
      account_id: sharedAccount.id,
      has_attachment: 1,
    });
    const body = await context.handlers[DB_RPC.MESSAGE_BODY_READ]({
      messageId: local.id,
    });
    expect(body.attachments.map((part: any) => ({
      name: part.name,
      mime_type: part.mime_type,
    }))).toEqual([
      { name: 'photo.png', mime_type: 'image/png' },
      { name: 'doc.pdf', mime_type: 'application/pdf' },
    ]);
    expect(body.attachments.every((part: any) => typeof part.blob_id === 'string'))
      .toBe(true);

    const originalDownloadBlob = context.transport.downloadBlob.bind(context.transport);
    const routedAccountIds: string[] = [];
    context.transport.downloadBlob = async (args: any) => {
      routedAccountIds.push(args.accountId);
      return originalDownloadBlob(args);
    };
    try {
      const png = await context.backend.downloadAttachment({
        accountId: sharedAccount.id,
        blobId: body.attachments[0].blob_id,
        type: 'image/png',
        name: 'photo.png',
      });
      const pdf = await context.backend.downloadAttachment({
        accountId: sharedAccount.id,
        blobId: body.attachments[1].blob_id,
        type: 'application/pdf',
        name: 'doc.pdf',
      });
      expect(await bytesOf(png)).toEqual(PNG_BYTES);
      expect(await bytesOf(pdf)).toEqual(PDF_BYTES);
      expect(owner.accountId).not.toBe(context.account.remote_account_id);
      expect(routedAccountIds).toEqual([owner.accountId, owner.accountId]);
    } finally {
      context.transport.downloadBlob = originalDownloadBlob;
    }
  });

  it('uploads once, reuses canonical draft parts, and sends without a second upload', async () => {
    const subject = `${prefix} compose`;
    const draftSessionId = randomUUID();
    const originalUpload = context.transport.upload.bind(context.transport);
    let uploadCount = 0;
    context.transport.upload = async (args: any) => {
      uploadCount += 1;
      return originalUpload(args);
    };

    try {
      const uploaded = await context.backend.uploadComposeAttachment({
        accountId: context.account.id,
        blob: new Blob([PDF_BYTES], { type: 'application/pdf' }),
        type: 'application/pdf',
      });
      expect(uploaded).toMatchObject({
        accountId: context.account.remote_account_id,
        blobId: expect.any(String),
        type: 'application/pdf',
        size: PDF_BYTES.byteLength,
      });

      const first = await runMutation(MUTATION_TYPES.SAVE_DRAFT, draftRequest(1, {
        draftSessionId,
        subject,
        textBody: 'First attached revision',
        attachments: [{
          part_id: '',
          blob_id: uploaded.blobId,
          name: 'report.pdf',
          mime_type: 'application/pdf',
          size: PDF_BYTES.byteLength,
          disposition: 'attachment',
          cid: null,
        }],
      }));
      if (!first.ok) throw new Error(JSON.stringify(first.error));
      createdEmailIds.add(first.result.emailId);
      const firstRemote = await remoteEmail(mail, first.result.emailId);
      expect(firstRemote).toMatchObject({
        keywords: expect.objectContaining({ $draft: true }),
        hasAttachment: true,
      });
      expect(firstRemote.bodyStructure.type).toBe('multipart/mixed');
      expect(attachmentLeaves(firstRemote.bodyStructure)[0]).toMatchObject({
        name: 'report.pdf',
        type: 'application/pdf',
        disposition: 'attachment',
      });
      const firstLocal = await context.handlers[DB_RPC.MESSAGE_GET_BY_REMOTE]({
        accountId: context.account.id,
        remoteId: first.result.emailId,
      });
      const firstBody = await context.handlers[DB_RPC.MESSAGE_BODY_READ]({
        messageId: firstLocal.id,
      });
      expect(firstLocal).toMatchObject({ is_draft: 1, has_attachment: 1 });
      expect(firstBody.attachments).toEqual([expect.objectContaining({
        name: 'report.pdf',
        mime_type: 'application/pdf',
        disposition: 'attachment',
        part_id: expect.any(String),
        blob_id: expect.any(String),
      })]);
      const canonical = firstBody.attachments[0];
      expect(await bytesOf(await context.backend.downloadAttachment({
        accountId: context.account.id,
        blobId: canonical.blob_id,
        type: 'application/pdf',
        name: 'report.pdf',
      }))).toEqual(PDF_BYTES);

      const second = await runMutation(MUTATION_TYPES.SAVE_DRAFT, draftRequest(2, {
        draftSessionId,
        subject,
        textBody: 'Second attached revision',
        attachments: [canonical],
        draftEmailIds: [first.result.emailId],
      }));
      if (!second.ok) throw new Error(JSON.stringify(second.error));
      createdEmailIds.add(second.result.emailId);
      expect(second.result.emailId).not.toBe(first.result.emailId);
      expect(await remoteEmail(mail, first.result.emailId)).toBeNull();
      const secondRemote = await remoteEmail(mail, second.result.emailId);
      const secondPart = attachmentLeaves(secondRemote.bodyStructure)[0];
      expect(secondPart).toMatchObject({
        name: 'report.pdf',
        type: 'application/pdf',
      });
      expect(await bytesOf(await context.backend.downloadAttachment({
        accountId: context.account.id,
        blobId: secondPart.blobId,
        type: 'application/pdf',
        name: 'report.pdf',
      }))).toEqual(PDF_BYTES);
      const secondLocal = await context.handlers[DB_RPC.MESSAGE_GET_BY_REMOTE]({
        accountId: context.account.id,
        remoteId: second.result.emailId,
      });
      const secondBody = await context.handlers[DB_RPC.MESSAGE_BODY_READ]({
        messageId: secondLocal.id,
      });

      const sent = await runMutation(MUTATION_TYPES.SEND, {
        draftSessionId,
        identityId: identity.id,
        to: [{ email: SHARED_TEST_OIDC_EMAIL }],
        cc: [],
        bcc: [],
        subject,
        textBody: 'Second attached revision',
        htmlBody: '',
        attachments: secondBody.attachments,
        inReplyTo: [],
        references: [],
        draftsFolderId: draftsFolder.id,
        sentFolderId: sentFolder.id,
        outboxFolderId: null,
        draftEmailIds: [second.result.emailId],
      });
      if (!sent.ok) throw new Error(JSON.stringify(sent.error));
      createdEmailIds.add(sent.result.createdRemoteId);
      expect(await remoteEmail(mail, second.result.emailId)).toBeNull();

      const ownerInbox = await mailboxByRole(owner, 'inbox');
      const delivered = await waitForEmailBySubject(owner, ownerInbox.id, subject, {
        timeoutMs: 20_000,
        intervalMs: 250,
        label: 'attachment send to arrive in the shared-e2e inbox',
      });
      ownerEmailIds.add(delivered.id);
      const deliveredEmail = await remoteEmail(owner, delivered.id);
      const deliveredPart = attachmentLeaves(deliveredEmail.bodyStructure)[0];
      expect(deliveredPart).toMatchObject({
        name: 'report.pdf',
        type: 'application/pdf',
      });
      expect(await bytesOf(await context.backend.downloadAttachment({
        accountId: context.account.id,
        blobId: attachmentLeaves(
          (await remoteEmail(mail, sent.result.createdRemoteId)).bodyStructure,
        )[0].blobId,
        type: 'application/pdf',
        name: 'report.pdf',
      }))).toEqual(PDF_BYTES);
      expect(uploadCount).toBe(1);
    } finally {
      context.transport.upload = originalUpload;
    }
  });

  it('keeps a text-only predecessor when a missing blob fails, then retries', async () => {
    const subject = `${prefix} retry`;
    const draftSessionId = randomUUID();
    const textBody = 'Text draft before the missing attachment';

    const predecessor = await runMutation(MUTATION_TYPES.SAVE_DRAFT, draftRequest(1, {
      draftSessionId,
      subject,
      textBody,
      attachments: [],
    }));
    if (!predecessor.ok) throw new Error(JSON.stringify(predecessor.error));
    createdEmailIds.add(predecessor.result.emailId);
    const predecessorLocal = await context.handlers[DB_RPC.MESSAGE_GET_BY_REMOTE]({
      accountId: context.account.id,
      remoteId: predecessor.result.emailId,
    });

    const failed = await runMutation(MUTATION_TYPES.SAVE_DRAFT, draftRequest(2, {
      draftSessionId,
      subject,
      textBody,
      attachments: [{
        part_id: 'att-missing',
        blob_id: 'not-a-real-blob',
        name: 'missing.pdf',
        mime_type: 'application/pdf',
        size: 4,
        disposition: 'attachment',
        cid: null,
      }],
      draftEmailIds: [predecessor.result.emailId],
    }));
    expect(failed).toMatchObject({
      ok: false,
      error: { type: 'blobNotFound' },
    });
    expect(await remoteEmail(mail, predecessor.result.emailId)).toMatchObject({
      id: predecessor.result.emailId,
      keywords: expect.objectContaining({ $draft: true }),
    });
    expect(await context.handlers[DB_RPC.MESSAGE_BODY_READ]({
      messageId: predecessorLocal.id,
    })).toMatchObject({
      text: textBody,
      attachments: [],
    });

    const uploaded = await context.backend.uploadComposeAttachment({
      accountId: context.account.id,
      blob: new Blob([PDF_BYTES], { type: 'application/pdf' }),
      type: 'application/pdf',
    });
    const recovered = await runMutation(MUTATION_TYPES.SAVE_DRAFT, draftRequest(3, {
      draftSessionId,
      subject,
      textBody,
      attachments: [{
        part_id: '',
        blob_id: uploaded.blobId,
        name: 'recovered.pdf',
        mime_type: 'application/pdf',
        size: PDF_BYTES.byteLength,
        disposition: 'attachment',
        cid: null,
      }],
      draftEmailIds: [predecessor.result.emailId],
    }));
    if (!recovered.ok) throw new Error(JSON.stringify(recovered.error));
    createdEmailIds.add(recovered.result.emailId);
    expect(recovered.result.emailId).not.toBe(predecessor.result.emailId);
    expect(await remoteEmail(mail, predecessor.result.emailId)).toBeNull();
    const recoveredLocal = await context.handlers[DB_RPC.MESSAGE_GET_BY_REMOTE]({
      accountId: context.account.id,
      remoteId: recovered.result.emailId,
    });
    const recoveredBody = await context.handlers[DB_RPC.MESSAGE_BODY_READ]({
      messageId: recoveredLocal.id,
    });
    expect(recoveredBody).toMatchObject({
      text: textBody,
      attachments: [expect.objectContaining({
        name: 'recovered.pdf',
        mime_type: 'application/pdf',
      })],
    });
    expect(await bytesOf(await context.backend.downloadAttachment({
      accountId: context.account.id,
      blobId: recoveredBody.attachments[0].blob_id,
      type: 'application/pdf',
      name: 'recovered.pdf',
    }))).toEqual(PDF_BYTES);
  });
});
