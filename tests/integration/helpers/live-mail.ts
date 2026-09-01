/**
 * Raw JMAP mail reads, cleanup, and delivery polling against a live
 * account. Every helper takes a `LiveMailAccount` so the same code serves
 * the integration account (via `liveMailAccount(context)`) and a second
 * principal returned by `createLiveTransport`.
 */

import {
  callMethod,
  type LiveRequestTransport,
  MAIL_USING,
} from './live-jmap';

export interface LiveMailAccount {
  transport: LiveRequestTransport;
  accountId: string;
}

export function liveMailAccount(context: {
  transport: LiveRequestTransport;
  account: { remote_account_id: string };
}): LiveMailAccount {
  return { transport: context.transport, accountId: context.account.remote_account_id };
}

export const MAILBOX_PROPERTIES = ['id', 'name', 'role', 'parentId', 'isSubscribed'] as const;

/** Enough of an Email to match it by subject and place it. */
export const EMAIL_SUMMARY_PROPERTIES = ['id', 'subject', 'mailboxIds', 'hasAttachment'] as const;

/** Everything the live suites inspect on a single Email. */
export const EMAIL_INSPECT_PROPERTIES = [
  'id',
  'blobId',
  'mailboxIds',
  'keywords',
  'sentAt',
  'receivedAt',
  'subject',
  'hasAttachment',
  'bodyStructure',
  'textBody',
  'htmlBody',
  'attachments',
] as const;

const PAGE_LIMIT = 500;

export async function remoteMailboxes(
  { transport, accountId }: LiveMailAccount,
  {
    ids,
    properties = MAILBOX_PROPERTIES,
  }: { ids?: string[]; properties?: readonly string[] } = {},
): Promise<any[]> {
  const result = await callMethod(transport, MAIL_USING, 'Mailbox/get', {
    accountId,
    ...(ids ? { ids } : {}),
    properties: [...properties],
  }, 'mailboxes');
  return result.list ?? [];
}

export async function remoteMailbox(account: LiveMailAccount, id: string): Promise<any | null> {
  return (await remoteMailboxes(account, { ids: [id] }))[0] ?? null;
}

/** The account's mailbox with `role`; throws when the account has none. */
export async function mailboxByRole(account: LiveMailAccount, role: string): Promise<any> {
  const mailbox = (await remoteMailboxes(account)).find((item: any) => item.role === role);
  if (!mailbox) throw new Error(`No ${role} mailbox on ${account.accountId}`);
  return mailbox;
}

export async function remoteEmail(
  { transport, accountId }: LiveMailAccount,
  id: string,
  properties: readonly string[] = EMAIL_INSPECT_PROPERTIES,
): Promise<any | null> {
  const result = await callMethod(transport, MAIL_USING, 'Email/get', {
    accountId,
    ids: [id],
    properties: [...properties],
  }, 'email');
  return result.list?.[0] ?? null;
}

/** The first page of Emails in `mailboxId`, fetched with `properties`. */
export async function emailsInMailbox(
  { transport, accountId }: LiveMailAccount,
  mailboxId: string,
  properties: readonly string[] = EMAIL_SUMMARY_PROPERTIES,
): Promise<any[]> {
  const queried = await callMethod(transport, MAIL_USING, 'Email/query', {
    accountId,
    filter: { inMailbox: mailboxId },
    limit: PAGE_LIMIT,
  }, 'mailbox-query');
  const ids = queried.ids ?? [];
  if (ids.length === 0) return [];
  const fetched = await callMethod(transport, MAIL_USING, 'Email/get', {
    accountId,
    ids,
    properties: [...properties],
  }, 'mailbox-get');
  return fetched.list ?? [];
}

export async function emailsByExactSubject(
  account: LiveMailAccount,
  mailboxId: string,
  subject: string,
  properties: readonly string[] = EMAIL_SUMMARY_PROPERTIES,
): Promise<any[]> {
  return (await emailsInMailbox(account, mailboxId, properties))
    .filter((email: any) => email.subject === subject);
}

export async function destroyEmails(
  { transport, accountId }: LiveMailAccount,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  await callMethod(transport, MAIL_USING, 'Email/set', {
    accountId,
    destroy: [...ids],
  }, 'destroy-emails');
}

/** Destroy every Email in `mailboxId` whose subject starts with `prefix`. */
export async function destroyEmailsWithSubjectPrefix(
  account: LiveMailAccount,
  mailboxId: string,
  prefix: string,
): Promise<string[]> {
  const ids = (await emailsInMailbox(account, mailboxId, ['id', 'subject']))
    .filter((email: any) => String(email.subject ?? '').startsWith(prefix))
    .map((email: any) => email.id);
  await destroyEmails(account, ids);
  return ids;
}

export interface PollOptions {
  timeoutMs: number;
  intervalMs?: number;
  /** Names the awaited condition in the timeout error. */
  label: string;
}

/** Repeat `probe` until it yields a non-null value or `timeoutMs` passes. */
export async function pollUntil<T>(
  probe: () => Promise<T | null>,
  { timeoutMs, intervalMs = 2_000, label }: PollOptions,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value != null) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
  }
}

/** The first Email with exactly `subject` to appear in `mailboxId`. */
export async function waitForEmailBySubject(
  account: LiveMailAccount,
  mailboxId: string,
  subject: string,
  options: PollOptions,
): Promise<any> {
  return pollUntil(
    async () => (await emailsByExactSubject(account, mailboxId, subject))[0] ?? null,
    options,
  );
}
