/**
 * Fixtures for the Send Later suites: an account with Drafts, Sent, and
 * Scheduled folders plus the scheduled-mailbox setting, Email objects
 * shaped like the ones the server returns for held messages, and a
 * cached message row already marked as scheduled.
 */

import { bootTestEngine } from '../../../src/db/bootstrap-memory';
import { makeHandlers } from '../../../src/db/handlers';
import { DB_RPC } from '../../../src/db/protocol';
import { syncFolderWindow } from '../../../src/sync/backends/jmap/messages';
import { MockTransport } from './_mock-transport';

export const DRAFTS_MAILBOX_ID = 'mb-drafts';
export const SENT_MAILBOX_ID = 'mb-sent';
export const SCHEDULED_MAILBOX_ID = 'mb-sched';

// Target validation runs against the real clock (scheduleClockWindow),
// so the future/past instants are relative to module load.
export const NOW = Date.now();
export const FUTURE_AT = new Date(NOW + 60 * 60_000).toISOString();
export const PAST_AT = new Date(NOW - 60 * 60_000).toISOString();

export interface ScheduledEmailOverrides {
  blobId?: string;
  threadId?: string;
  mailboxIds?: Record<string, boolean>;
  keywords?: Record<string, boolean>;
  size?: number;
  receivedAt?: string;
  sentAt?: string;
  from?: Array<{ email: string; name?: string }>;
  to?: Array<{ email: string; name?: string }>;
  subject?: string;
  preview?: string;
  hasAttachment?: boolean;
}

/** Email object for a held message sitting in the Scheduled mailbox. */
export function scheduledEmailFixture(id: string, overrides: ScheduledEmailOverrides = {}) {
  return {
    id,
    blobId: `b-${id}`,
    threadId: `t-${id}`,
    mailboxIds: { [SCHEDULED_MAILBOX_ID]: true },
    keywords: { $seen: true },
    size: 1,
    receivedAt: new Date(NOW).toISOString(),
    sentAt: FUTURE_AT,
    messageId: [`<${id}@example.com>`],
    from: [{ email: 'me@example.com' }],
    to: [{ email: 'rcpt@example.com' }],
    subject: `s-${id}`,
    preview: 'p',
    hasAttachment: false,
    ...overrides,
  };
}

export interface ScheduledAccountContext {
  engine: any;
  handlers: Record<string, (params: any) => Promise<any>>;
  account: any;
  draftsFolder: any;
  sentFolder: any;
  scheduledFolder: any;
}

export interface BootScheduledAccountOptions {
  /** Subscription state of the Scheduled folder row. */
  scheduledSubscribed?: boolean;
}

/**
 * Fresh in-memory engine with one primary account, the three mail
 * folders, and `scheduledMailboxRemoteId` pointing at Scheduled.
 */
export async function bootScheduledAccount({
  scheduledSubscribed = true,
}: BootScheduledAccountOptions = {}): Promise<ScheduledAccountContext> {
  const engine = await bootTestEngine();
  const handlers = makeHandlers(engine);
  const account = (await handlers[DB_RPC.ACCOUNT_UPSERT]({
    displayName: 'T',
    primaryEmail: 't@example.com',
    serverOrigin: 'https://mail.example.com',
    remoteAccountId: 'acct-1',
    isPrimary: true,
  })).row;
  await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
    accountId: account.id,
    folders: [
      { remoteId: DRAFTS_MAILBOX_ID, name: 'Drafts', role: 'drafts', sortOrder: 1 },
      { remoteId: SENT_MAILBOX_ID, name: 'Sent', role: 'sent', sortOrder: 2 },
      {
        remoteId: SCHEDULED_MAILBOX_ID,
        name: 'Scheduled',
        role: null,
        sortOrder: 3,
        isSubscribed: scheduledSubscribed,
      },
    ],
  });
  await handlers[DB_RPC.SETTINGS_APPLY_PATCH]({
    accountId: account.id,
    patch: { scheduledMailboxRemoteId: SCHEDULED_MAILBOX_ID },
  });
  const folder = (remoteId: string) => engine.get(
    'SELECT * FROM folders WHERE account_id = ? AND remote_id = ?',
    [account.id, remoteId],
  );
  return {
    engine,
    handlers,
    account,
    draftsFolder: await folder(DRAFTS_MAILBOX_ID),
    sentFolder: await folder(SENT_MAILBOX_ID),
    scheduledFolder: await folder(SCHEDULED_MAILBOX_ID),
  };
}

export interface SeedScheduledMessageOptions {
  sentAt?: string;
  /** Submission the row is tracked under; null seeds an untracked row. */
  submissionId?: string | null;
  undoStatus?: string;
}

/**
 * Sync one Email into the Scheduled window and mark the cached row as
 * scheduled under `submissionId`. Returns the messages row.
 */
export async function seedScheduledMessage(
  { engine, handlers, account, scheduledFolder }: ScheduledAccountContext,
  remoteId: string,
  {
    sentAt = FUTURE_AT,
    submissionId = `sub-${remoteId}`,
    undoStatus = 'pending',
  }: SeedScheduledMessageOptions = {},
) {
  const t = new MockTransport();
  t.handle('Email/query', () => ({
    ids: [remoteId],
    total: 1,
    queryState: `qs-${remoteId}`,
    canCalculateChanges: true,
    position: 0,
  }));
  t.handle('Email/get', (params) => ({
    list: params.ids.map((id: string) => scheduledEmailFixture(id, { sentAt })),
    state: 'es',
  }));
  await syncFolderWindow({ transport: t, account, folder: scheduledFolder, handlers });
  await handlers[DB_RPC.MESSAGE_SET_SCHEDULED]({
    accountId: account.id,
    emailRemoteId: remoteId,
    submissionRemoteId: submissionId,
    undoStatus,
  });
  return engine.get(
    'SELECT * FROM messages WHERE account_id = ? AND remote_id = ?',
    [account.id, remoteId],
  );
}
