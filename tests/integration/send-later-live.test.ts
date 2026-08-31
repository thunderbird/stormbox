/**
 * Live Send Later verticals against the Docker Stalwart stack.
 *
 * Sequential story on one schedule where possible: create a held send
 * and check every surface that carries the target instant (Email.sentAt,
 * the raw MIME Date header, EmailSubmission.sendAt) plus conditional
 * subscription; cancel it back to Drafts; release a short schedule
 * through delivery and Sent filing; and adopt a schedule created by
 * another client into a fresh engine (reload recovery).
 */

import { randomUUID } from 'node:crypto';

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';

import { DB_RPC } from '../../src/db/protocol';
import { syncIdentities } from '../../src/sync/backends/jmap/identities';
import { syncMailboxes } from '../../src/sync/backends/jmap/mailboxes';
import {
  MUTATION_TYPES,
  processMutationRow,
} from '../../src/sync/backends/jmap/outbox';
import {
  fetchSubmissionRecords,
  syncSubmissionsForAccount,
} from '../../src/sync/backends/jmap/submissions';
import { makeOperationId } from '../../src/utils/message-id';
import {
  INTEGRATION_TEST_OIDC_EMAIL,
  SHARED_TEST_OIDC_EMAIL,
  SHARED_TEST_OIDC_PASSWORD,
} from '../e2e/helpers/stack-env';
import {
  createLiveMailIntegrationContext,
  createLiveTransport,
  MAIL_USING,
  requireResponseById,
} from './helpers/live-jmap';

const PDF_BYTES = new TextEncoder().encode('%PDF-1.1\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

/** A whole-second future instant; Date headers carry second precision. */
function futureTargetAt(secondsFromNow: number): string {
  return new Date((Math.floor(Date.now() / 1000) + secondsFromNow) * 1000).toISOString();
}

async function pollUntil<T>(
  probe: () => Promise<T | null>,
  { timeoutMs, intervalMs = 2_000, label }: {
    timeoutMs: number; intervalMs?: number; label: string;
  },
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value != null) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
  }
}

describe.sequential('live Stalwart Send Later', () => {
  const prefix = `Stormbox sched ${randomUUID()}`;
  let context: Awaited<ReturnType<typeof createLiveMailIntegrationContext>>;
  // Recipient on a separate account: Stalwart dedups ingest by
  // Message-ID per account, so a self-addressed send would never show a
  // distinct inbox copy and delivery could not be asserted.
  let owner: Awaited<ReturnType<typeof createLiveTransport>>;
  let ownerInboxId: string;
  let draftsFolder: any;
  let sentFolder: any;
  let identity: any;

  async function request(methodCalls: any[], using: readonly string[] = MAIL_USING) {
    return context.transport.request([...using], methodCalls);
  }

  async function remoteEmail(id: string) {
    const result = requireResponseById(
      await request([[
        'Email/get',
        {
          accountId: context.account.remote_account_id,
          ids: [id],
          properties: [
            'id', 'blobId', 'mailboxIds', 'keywords', 'sentAt', 'receivedAt',
            'subject', 'hasAttachment',
          ],
        },
        'email',
      ]]),
      'Email/get',
      'email',
    );
    return result.list?.[0] ?? null;
  }

  async function remoteMailbox(id: string) {
    const result = requireResponseById(
      await request([[
        'Mailbox/get',
        {
          accountId: context.account.remote_account_id,
          ids: [id],
          properties: ['id', 'name', 'role', 'parentId', 'isSubscribed'],
        },
        'mailbox',
      ]]),
      'Mailbox/get',
      'mailbox',
    );
    return result.list?.[0] ?? null;
  }

  async function ownerInboxBySubject(subject: string) {
    const queried = requireResponseById(
      await owner.transport.request([...MAIL_USING], [[
        'Email/query',
        {
          accountId: owner.accountId,
          filter: { inMailbox: ownerInboxId },
          limit: 500,
        },
        'owner-query',
      ]]),
      'Email/query',
      'owner-query',
    );
    const ids = queried.ids ?? [];
    if (ids.length === 0) return [];
    const fetched = requireResponseById(
      await owner.transport.request([...MAIL_USING], [[
        'Email/get',
        {
          accountId: owner.accountId,
          ids,
          properties: ['id', 'subject', 'hasAttachment'],
        },
        'owner-get',
      ]]),
      'Email/get',
      'owner-get',
    );
    return (fetched.list ?? []).filter((email: any) => email.subject === subject);
  }

  async function runMutation(mutationType: string, requestJson: Record<string, unknown>) {
    const inserted = await context.handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId: context.account.id,
      mutationType,
      targetMessageId: null,
      requestJson: JSON.stringify(requestJson),
    });
    const rows = await context.handlers[DB_RPC.QUERY]({
      sql: 'SELECT * FROM pending_mutations WHERE id = ?',
      params: [inserted.id],
    });
    const outcome = await processMutationRow({
      transport: context.transport,
      account: context.account,
      handlers: context.handlers,
      row: rows[0],
    });
    // The status bookkeeping drainOutbox would do; without it the row
    // stays 'pending' and later drains would re-run the operation.
    await context.handlers[DB_RPC.QUERY]({
      sql: 'DELETE FROM pending_mutations WHERE id = ?',
      params: [inserted.id],
    });
    return outcome;
  }

  /**
   * Process queued schedule-lifecycle mutations (moves, cancels,
   * subscription flips) the way the outbox runner would, leaving
   * unrelated queued work (settings pushes) alone.
   */
  async function drainScheduleMutations() {
    for (let pass = 0; pass < 10; pass += 1) {
      const rows = await context.handlers[DB_RPC.QUERY]({
        sql: `SELECT * FROM pending_mutations
               WHERE account_id = ? AND local_status IN ('pending', 'retry')
                 AND mutation_type IN (?, ?, ?)
               ORDER BY id`,
        params: [
          context.account.id,
          MUTATION_TYPES.MOVE_TO_FOLDERS,
          MUTATION_TYPES.CANCEL_SCHEDULED_SEND,
          MUTATION_TYPES.SET_MAILBOX_SUBSCRIPTION,
        ],
      });
      if (!rows || rows.length === 0) return;
      for (const row of rows) {
        const outcome = await processMutationRow({
          transport: context.transport,
          account: context.account,
          handlers: context.handlers,
          row,
        });
        if (!outcome.ok) {
          throw new Error(
            `${row.mutation_type} mutation failed: ${JSON.stringify(outcome.error)}`,
          );
        }
        await context.handlers[DB_RPC.QUERY]({
          sql: 'DELETE FROM pending_mutations WHERE id = ?',
          params: [row.id],
        });
      }
    }
    throw new Error('Schedule mutations did not drain in 10 passes');
  }

  function sendRequest(fields: {
    subject: string;
    scheduledAt: string;
    textBody?: string;
    htmlBody?: string;
    attachments?: unknown[];
  }) {
    return {
      operationId: makeOperationId(),
      identityId: identity.id,
      to: [{ email: SHARED_TEST_OIDC_EMAIL }],
      cc: [],
      bcc: [],
      subject: fields.subject,
      textBody: fields.textBody ?? 'Scheduled body.',
      htmlBody: fields.htmlBody ?? '',
      attachments: fields.attachments ?? [],
      inReplyTo: [],
      references: [],
      draftsFolderId: draftsFolder.id,
      sentFolderId: sentFolder.id,
      outboxFolderId: null,
      draftEmailIds: [],
      scheduledAt: fields.scheduledAt,
    };
  }

  async function trackedRowBySubject(subject: string) {
    const rows = await context.handlers[DB_RPC.QUERY]({
      sql: `SELECT id, remote_id, sent_at, subject,
                   scheduled_submission_remote_id, scheduled_undo_status
              FROM messages
             WHERE account_id = ? AND subject = ?`,
      params: [context.account.id, subject],
    });
    return rows?.[0] ?? null;
  }

  async function placementsOf(messageId: number) {
    return context.handlers[DB_RPC.QUERY]({
      sql: `SELECT f.role, f.remote_id FROM folder_messages fm
              JOIN folders f ON f.id = fm.folder_id
             WHERE fm.message_id = ?`,
      params: [messageId],
    });
  }

  async function scheduledMailboxRemoteId(): Promise<string | null> {
    const current = await context.handlers[DB_RPC.SETTINGS_GET]({
      accountId: context.account.id,
    });
    const cached = current?.doc?.settings?.scheduledMailboxRemoteId;
    return typeof cached === 'string' && cached.length > 0 ? cached : null;
  }

  async function submissionForEmail(emailRemoteId: string) {
    const records = await fetchSubmissionRecords({
      transport: context.transport,
      account: context.account,
    });
    return records.filter((record) => record.emailId === emailRemoteId);
  }

  /**
   * The integration account is dedicated to these suites: revoke every
   * pending submission and remove leftover scheduled/test mail so a
   * crashed earlier run cannot skew subscription-level assertions.
   */
  async function purgeScheduleState() {
    const records = await fetchSubmissionRecords({
      transport: context.transport,
      account: context.account,
    });
    const pending = records.filter((record) => record.undoStatus === 'pending');
    if (pending.length > 0) {
      await request([[
        'EmailSubmission/set',
        {
          accountId: context.account.remote_account_id,
          update: Object.fromEntries(
            pending.map((record) => [record.id, { undoStatus: 'canceled' }]),
          ),
        },
        'purge-cancel',
      ]], [...MAIL_USING, 'urn:ietf:params:jmap:submission']);
    }
    const mailboxes = requireResponseById(
      await request([[
        'Mailbox/get',
        {
          accountId: context.account.remote_account_id,
          properties: ['id', 'name', 'role', 'parentId'],
        },
        'purge-mailboxes',
      ]]),
      'Mailbox/get',
      'purge-mailboxes',
    ).list ?? [];
    const scheduled = mailboxes.find(
      (mailbox: any) => mailbox.name === 'Scheduled' && mailbox.role == null
        && mailbox.parentId == null,
    );
    const doomed = new Set<string>();
    for (const mailbox of mailboxes) {
      const managed = scheduled && mailbox.id === scheduled.id;
      const role = ['inbox', 'drafts', 'sent', 'trash'].includes(mailbox.role);
      if (!managed && !role) continue;
      const listed = requireResponseById(
        await request([[
          'Email/query',
          {
            accountId: context.account.remote_account_id,
            filter: { inMailbox: mailbox.id },
            limit: 500,
          },
          'purge-query',
        ]]),
        'Email/query',
        'purge-query',
      ).ids ?? [];
      if (listed.length === 0) continue;
      const fetched = requireResponseById(
        await request([[
          'Email/get',
          {
            accountId: context.account.remote_account_id,
            ids: listed,
            properties: ['id', 'subject'],
          },
          'purge-get',
        ]]),
        'Email/get',
        'purge-get',
      ).list ?? [];
      for (const email of fetched) {
        if (managed || String(email.subject ?? '').startsWith('Stormbox sched ')) {
          doomed.add(email.id);
        }
      }
    }
    if (doomed.size > 0) {
      requireResponseById(
        await request([[
          'Email/set',
          { accountId: context.account.remote_account_id, destroy: [...doomed] },
          'purge-destroy',
        ]]),
        'Email/set',
        'purge-destroy',
      );
    }
    if (scheduled) {
      await request([[
        'Mailbox/set',
        {
          accountId: context.account.remote_account_id,
          update: { [scheduled.id]: { isSubscribed: true } },
        },
        'purge-subscribe',
      ]]);
    }
    if (owner) {
      const listed = requireResponseById(
        await owner.transport.request([...MAIL_USING], [[
          'Email/query',
          {
            accountId: owner.accountId,
            filter: { inMailbox: ownerInboxId },
            limit: 500,
          },
          'purge-owner-query',
        ]]),
        'Email/query',
        'purge-owner-query',
      ).ids ?? [];
      if (listed.length > 0) {
        const fetched = requireResponseById(
          await owner.transport.request([...MAIL_USING], [[
            'Email/get',
            { accountId: owner.accountId, ids: listed, properties: ['id', 'subject'] },
            'purge-owner-get',
          ]]),
          'Email/get',
          'purge-owner-get',
        ).list ?? [];
        const doomedOwner = fetched
          .filter((email: any) => String(email.subject ?? '').startsWith('Stormbox sched '))
          .map((email: any) => email.id);
        if (doomedOwner.length > 0) {
          await owner.transport.request([...MAIL_USING], [[
            'Email/set',
            { accountId: owner.accountId, destroy: doomedOwner },
            'purge-owner-destroy',
          ]]);
        }
      }
    }
  }

  beforeAll(async () => {
    context = await createLiveMailIntegrationContext();
    owner = await createLiveTransport({
      email: SHARED_TEST_OIDC_EMAIL,
      password: SHARED_TEST_OIDC_PASSWORD,
    });
    const ownerMailboxes = requireResponseById(
      await owner.transport.request([...MAIL_USING], [[
        'Mailbox/get',
        { accountId: owner.accountId, properties: ['id', 'role'] },
        'owner-mailboxes',
      ]]),
      'Mailbox/get',
      'owner-mailboxes',
    ).list ?? [];
    ownerInboxId = ownerMailboxes.find((mailbox: any) => mailbox.role === 'inbox')?.id;
    if (!ownerInboxId) throw new Error('Recipient account has no inbox');
    await purgeScheduleState();
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
      accountId: context.account.id, role: 'drafts',
    });
    sentFolder = await context.handlers[DB_RPC.FOLDER_BY_ROLE]({
      accountId: context.account.id, role: 'sent',
    });
    const identities = await context.handlers[DB_RPC.IDENTITY_LIST]({
      accountId: context.account.id,
    });
    identity = identities[0];
    if (!draftsFolder || !sentFolder || !identity) {
      throw new Error('Integration mail account is missing core folders or an identity');
    }
  });

  afterAll(async () => {
    try {
      await purgeScheduleState();
    } finally {
      await context?.engine.close();
    }
  });

  const holdSubject = `${prefix} hold`;
  const holdTargetAt = futureTargetAt(2 * 60 * 60);

  it('schedules a message and the target instant shows on every surface', async () => {
    const outcome = await runMutation(MUTATION_TYPES.SEND, sendRequest({
      subject: holdSubject,
      scheduledAt: holdTargetAt,
    }));
    expect(outcome.ok).toBe(true);

    const row = await trackedRowBySubject(holdSubject);
    expect(row).toBeTruthy();
    expect(row.scheduled_undo_status).toBe('pending');
    expect(row.scheduled_submission_remote_id).toBeTruthy();
    expect(Number(row.sent_at)).toBe(Date.parse(holdTargetAt));

    // The Email sits in the managed Scheduled mailbox wearing its future
    // send time, read, and not a draft.
    const scheduledRemoteId = await scheduledMailboxRemoteId();
    expect(scheduledRemoteId).toBeTruthy();
    const email = await remoteEmail(row.remote_id);
    expect(email.mailboxIds).toEqual({ [scheduledRemoteId as string]: true });
    expect(Date.parse(email.sentAt)).toBe(Date.parse(holdTargetAt));
    expect(email.keywords?.$seen).toBe(true);
    expect(email.keywords?.$draft).toBeUndefined();

    // The raw MIME Date header carries the same instant, so external
    // clients date the message by when it will leave, Fastmail-style.
    const bytes = await context.transport.download({
      accountId: context.account.remote_account_id,
      blobId: email.blobId,
      type: 'message/rfc822',
      name: 'scheduled.eml',
    });
    const source = new TextDecoder().decode(bytes);
    const dateHeader = /^Date:[ \t]*(.+)$/m.exec(source)?.[1];
    expect(dateHeader).toBeTruthy();
    expect(Date.parse(String(dateHeader))).toBe(Date.parse(holdTargetAt));

    // The submission is held (pending) with sendAt at/near the target;
    // HOLDFOR rounds up from the clock window, never early.
    const submissions = await submissionForEmail(row.remote_id);
    expect(submissions).toHaveLength(1);
    expect(submissions[0].id).toBe(row.scheduled_submission_remote_id);
    expect(submissions[0].undoStatus).toBe('pending');
    const sendAtMs = Date.parse(String(submissions[0].sendAt));
    expect(Math.abs(sendAtMs - Date.parse(holdTargetAt))).toBeLessThanOrEqual(120_000);

    // The managed mailbox remains subscribed and visible to every client.
    await drainScheduleMutations();
    expect((await remoteMailbox(scheduledRemoteId as string)).isSubscribed).toBe(true);

    // A live sync pass reads the same state back without inventing a
    // transition, and reports the schedule as the nearest wake-up.
    const sync = await syncSubmissionsForAccount({
      transport: context.transport,
      account: context.account,
      handlers: context.handlers,
    });
    expect(sync.nearestPendingAt).toBe(Date.parse(holdTargetAt));
    expect(sync.unresolvedSettled).toBe(false);
    expect((await trackedRowBySubject(holdSubject)).scheduled_undo_status).toBe('pending');
  });

  it('cancels the held schedule back to an editable draft and keeps the mailbox visible', async () => {
    const row = await trackedRowBySubject(holdSubject);
    expect(row?.scheduled_undo_status).toBe('pending');
    const scheduledRemoteId = await scheduledMailboxRemoteId();

    const outcome = await runMutation(MUTATION_TYPES.CANCEL_SCHEDULED_SEND, {
      messageId: row.id,
    });
    expect(outcome.ok).toBe(true);

    // Server: submission revoked, Email back in Drafts as a draft.
    const submissions = await submissionForEmail(row.remote_id);
    for (const record of submissions) {
      expect(record.undoStatus).toBe('canceled');
    }
    const email = await remoteEmail(row.remote_id);
    expect(email.mailboxIds).toEqual({ [draftsFolder.remote_id]: true });
    expect(email.keywords?.$draft).toBe(true);

    // Local: scheduling columns cleared, placement follows the server.
    const after = await trackedRowBySubject(holdSubject);
    expect(after.scheduled_undo_status).toBeNull();
    expect(after.scheduled_submission_remote_id).toBeNull();
    const placements = await placementsOf(after.id);
    expect(placements.map((p: any) => p.role)).toEqual(['drafts']);

    // No schedules remain, but the managed mailbox stays subscribed.
    await drainScheduleMutations();
    expect((await remoteMailbox(scheduledRemoteId as string)).isSubscribed).toBe(true);

    // The canceled copy never leaves: nothing with this subject reaches
    // the recipient (target was hours away; delivery would be immediate
    // only if the cancel had failed to hold).
    expect(await ownerInboxBySubject(holdSubject)).toHaveLength(0);
  });

  it('releases a short schedule through delivery, Sent filing, and cleared tracking', async () => {
    const subject = `${prefix} release`;
    const targetAt = futureTargetAt(10);
    const upload = await context.transport.upload({
      accountId: context.account.remote_account_id,
      type: 'application/pdf',
      body: PDF_BYTES,
    });

    const outcome = await runMutation(MUTATION_TYPES.SEND, sendRequest({
      subject,
      scheduledAt: targetAt,
      textBody: 'Short hold with attachment.',
      htmlBody: '<p>Short <strong>hold</strong> with attachment.</p>',
      attachments: [{
        blobId: upload.blobId,
        type: 'application/pdf',
        name: 'sched.pdf',
        disposition: 'attachment',
        partId: null,
        size: PDF_BYTES.byteLength,
      }],
    }));
    expect(outcome.ok).toBe(true);
    const row = await trackedRowBySubject(subject);
    expect(row.scheduled_undo_status).toBe('pending');
    await drainScheduleMutations();

    // The server releases the submission at the target and retains the
    // record as final (RFC 8621 §7).
    const finalRecord = await pollUntil(async () => {
      const records = await submissionForEmail(row.remote_id);
      return records.find((record) => record.undoStatus === 'final') ?? null;
    }, { timeoutMs: 90_000, label: 'submission release' });
    expect(finalRecord.undoStatus).toBe('final');

    // The delivered copy arrives in the recipient's inbox, attachment
    // and all.
    const delivered = await pollUntil(async () => {
      const matches = await ownerInboxBySubject(subject);
      return matches[0] ?? null;
    }, { timeoutMs: 60_000, label: 'recipient inbox delivery' });
    expect(delivered.hasAttachment).toBe(true);

    // Sync adopts the final status and hands the row to the durable
    // move; a second pass confirms Sent placement and clears tracking.
    const first = await syncSubmissionsForAccount({
      transport: context.transport,
      account: context.account,
      handlers: context.handlers,
    });
    expect(first.unresolvedSettled).toBe(true);
    await drainScheduleMutations();
    const second = await syncSubmissionsForAccount({
      transport: context.transport,
      account: context.account,
      handlers: context.handlers,
    });
    expect(second.unresolvedSettled).toBe(false);
    expect(second.nearestPendingAt).toBeNull();

    const after = await trackedRowBySubject(subject);
    expect(after.scheduled_undo_status).toBeNull();
    expect(after.scheduled_submission_remote_id).toBeNull();
    const placements = await placementsOf(after.id);
    expect(placements.map((p: any) => p.role)).toEqual(['sent']);
    const sentCopy = await remoteEmail(after.remote_id);
    expect(sentCopy.mailboxIds).toEqual({ [sentFolder.remote_id]: true });
    expect(sentCopy.hasAttachment).toBe(true);

    // With the last schedule resolved the mailbox remains visible.
    await drainScheduleMutations();
    const scheduledRemoteId = await scheduledMailboxRemoteId();
    expect((await remoteMailbox(scheduledRemoteId as string)).isSubscribed).toBe(true);
  }, 180_000);

  it('a fresh client adopts a schedule created by another client', async () => {
    const subject = `${prefix} external`;
    const targetAt = futureTargetAt(2 * 60 * 60);
    const scheduledRemoteId = await scheduledMailboxRemoteId();
    expect(scheduledRemoteId).toBeTruthy();

    // Another client: raw JMAP creates the scheduled Email and holds its
    // submission, without touching any Stormbox engine.
    const created = requireResponseById(
      await request([
        [
          'Email/set',
          {
            accountId: context.account.remote_account_id,
            create: {
              ext: {
                mailboxIds: { [scheduledRemoteId as string]: true },
                keywords: { $seen: true },
                from: [{ email: INTEGRATION_TEST_OIDC_EMAIL }],
                to: [{ email: INTEGRATION_TEST_OIDC_EMAIL }],
                subject,
                sentAt: targetAt,
                bodyStructure: { type: 'text/plain', partId: 'p1' },
                bodyValues: { p1: { value: 'External schedule.' } },
              },
            },
          },
          'ext-email',
        ],
        [
          'EmailSubmission/set',
          {
            accountId: context.account.remote_account_id,
            create: {
              extsub: {
                emailId: '#ext',
                identityId: identity.remote_id,
                envelope: {
                  mailFrom: {
                    email: INTEGRATION_TEST_OIDC_EMAIL,
                    parameters: { HOLDFOR: String(2 * 60 * 60) },
                  },
                  rcptTo: [{ email: INTEGRATION_TEST_OIDC_EMAIL, parameters: null }],
                },
              },
            },
          },
          'ext-sub',
        ],
      ], [...MAIL_USING, 'urn:ietf:params:jmap:submission']),
      'Email/set',
      'ext-email',
    );
    const externalEmailId = created.created?.ext?.id;
    expect(externalEmailId).toBeTruthy();

    // Reload recovery: a brand-new engine (fresh client) syncs mailboxes
    // and submissions and adopts the schedule it never created.
    const fresh = await createLiveMailIntegrationContext();
    try {
      await syncMailboxes({
        transport: fresh.transport,
        account: fresh.account,
        handlers: fresh.handlers,
      });
      const sync = await syncSubmissionsForAccount({
        transport: fresh.transport,
        account: fresh.account,
        handlers: fresh.handlers,
      });
      expect(sync.nearestPendingAt).toBe(Date.parse(targetAt));

      const adopted = await fresh.handlers[DB_RPC.QUERY]({
        sql: `SELECT remote_id, sent_at, scheduled_submission_remote_id,
                     scheduled_undo_status
                FROM messages WHERE account_id = ? AND subject = ?`,
        params: [fresh.account.id, subject],
      });
      expect(adopted).toHaveLength(1);
      expect(adopted[0].remote_id).toBe(externalEmailId);
      expect(adopted[0].scheduled_undo_status).toBe('pending');
      expect(adopted[0].scheduled_submission_remote_id).toBeTruthy();
      expect(Number(adopted[0].sent_at)).toBe(Date.parse(targetAt));

      // The fresh client also adopted the mailbox id into its settings
      // and kept the managed mailbox subscribed.
      const cached = await fresh.handlers[DB_RPC.SETTINGS_GET]({
        accountId: fresh.account.id,
      });
      expect(cached?.doc?.settings?.scheduledMailboxRemoteId).toBe(scheduledRemoteId);
    } finally {
      await fresh.engine.close();
    }
  }, 120_000);
});
