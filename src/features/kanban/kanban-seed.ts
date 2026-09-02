/**
 * One-time seeding for the kanban unlock: create "Needs Reply" and
 * "Blocked" on the signed-in account and file the static sample mail
 * into them through the outbox (CREATE_EMAILS).
 *
 * Duplicate-safe at folder granularity: existing folders are reused, the
 * folder counts are refreshed from the server (Mailbox/get) before
 * deciding, and a folder that already holds any mail is left alone. A
 * folder is therefore seeded at most once, and a folder whose seed was
 * interrupted after a partial server commit stays partial rather than
 * being topped up; CREATE_EMAILS is itself at-most-once, so a retry can
 * never file the same mail twice.
 */

import { MUTATION_TYPE } from '../../constants/states';
import { getRepositoryAsync } from '../../composables/useRepository';
import { useAuthStore } from '../../stores/auth-store';
import { useMailStore } from '../../stores/mail-store';
import type { FolderRow } from '../../types';
import type { CreateEmailSpec } from '../../sync/backends/jmap/outbox/operations/create-emails';
import { useKanbanStore } from './kanban-store';
import {
  BLOCKED_FOLDER_NAME,
  BLOCKED_MAILS,
  NEEDS_REPLY_FOLDER_NAME,
  NEEDS_REPLY_MAILS,
  type SeedMail,
} from './kanban-seed-data';

const FOLDER_APPEAR_TIMEOUT_MS = 8000;
const FOLDER_POLL_MS = 100;

export interface SeedResult {
  needsReplyFolderId: number;
  blockedFolderId: number;
  /** Emails created in this run (0 when both folders already had mail). */
  created: number;
}

interface SeedDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function buildSeedEmails(
  mails: readonly SeedMail[],
  recipient: { name?: string; email: string },
  now: number,
): CreateEmailSpec[] {
  return mails.map((mail, index) => ({
    clientId: `seed${index + 1}`,
    from: mail.from,
    to: [recipient],
    subject: mail.subject,
    receivedAt: now - mail.ageHours * 60 * 60 * 1000,
    keywords: mail.seen ? { $seen: true } : {},
    textBody: mail.body,
  }));
}

function sameName(a: string | null | undefined, b: string): boolean {
  return String(a ?? '').trim().toLowerCase() === b.trim().toLowerCase();
}

export async function seedKanbanFolders(deps: SeedDeps = {}): Promise<SeedResult> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const authStore = useAuthStore();
  const mailStore = useMailStore();
  const kanban = useKanbanStore();
  const accountId = authStore.accountId;
  if (accountId == null) throw new Error('Not signed in');
  // The sample mail is addressed to the signed-in user; only the OIDC
  // email claim is an address (a basic-auth username is not).
  const recipientEmail = authStore.email;
  if (!recipientEmail) throw new Error('No email address on this session to address the sample mail to');
  const recipient = { email: recipientEmail };
  const repo = await getRepositoryAsync();

  function findTopLevel(name: string): FolderRow | null {
    return (mailStore.primaryFolders as FolderRow[]).find((f) =>
      Number(f.is_deleted ?? 0) !== 1
      && (f.parent_id ?? null) == null
      && sameName(f.name, name)) ?? null;
  }

  async function ensureFolder(name: string): Promise<FolderRow> {
    const existing = findTopLevel(name);
    if (existing) return existing;
    const outcome = await mailStore.createFolder({ name });
    if (!outcome.ok && outcome.reason !== 'duplicateName') {
      throw new Error(`Could not create folder "${name}" (${outcome.reason ?? 'unknown'})`);
    }
    const deadline = now() + FOLDER_APPEAR_TIMEOUT_MS;
    for (;;) {
      await mailStore.refreshFolders();
      const created = findTopLevel(name);
      if (created) return created;
      if (now() >= deadline) throw new Error(`Folder "${name}" did not appear after creation`);
      await sleep(FOLDER_POLL_MS);
    }
  }

  /**
   * Authoritative folder counters: Mailbox/get into the cache, then
   * re-read the rows, so a folder seeded elsewhere (another device, an
   * earlier run whose response was lost) is recognised as populated.
   */
  async function refreshFolderCountsFromServer(): Promise<void> {
    if (typeof repo.ensureFolderTree === 'function') {
      await repo.ensureFolderTree(accountId);
    }
    await mailStore.refreshFolders();
  }

  async function seedInto(folder: FolderRow, mails: readonly SeedMail[]): Promise<number> {
    const current = findTopLevel(folder.name) ?? folder;
    if (Number(current.total_emails ?? 0) > 0) return 0;
    const emails = buildSeedEmails(mails, recipient, now());
    const mutation = await repo.insertPendingMutation({
      accountId,
      mutationType: MUTATION_TYPE.CREATE_EMAILS,
      targetMessageId: null,
      requestJson: JSON.stringify({ folderId: folder.id, emails }),
    });
    const outcome = await repo.runMutation(accountId, mutation.id);
    const succeeded = outcome?.result?.succeededIds?.length ?? 0;
    if ((outcome?.failed ?? 0) > 0 || (outcome?.succeeded ?? 0) === 0) {
      const detail = await repo.getPendingMutationError(mutation.id).catch(() => null);
      const reason = detail?.error_json ? safeErrorType(detail.error_json) : 'serverFail';
      throw new Error(`Seeding "${folder.name}" failed (${reason}); ${succeeded} of ${emails.length} created`);
    }
    return succeeded || emails.length;
  }

  const needsReply = await ensureFolder(NEEDS_REPLY_FOLDER_NAME);
  const blocked = await ensureFolder(BLOCKED_FOLDER_NAME);
  // Both column defaults are set before the mail lands so the board can
  // show the folders (and their loading state) right away.
  kanban.setDefaultColumns([needsReply.remote_id ?? null, blocked.remote_id ?? null]);

  await refreshFolderCountsFromServer();
  let created = 0;
  created += await seedInto(needsReply, NEEDS_REPLY_MAILS);
  created += await seedInto(blocked, BLOCKED_MAILS);
  await mailStore.refreshFolders();
  return { needsReplyFolderId: needsReply.id, blockedFolderId: blocked.id, created };
}

function safeErrorType(errorJson: string): string {
  try {
    return String(JSON.parse(errorJson)?.type ?? 'serverFail');
  } catch {
    return 'serverFail';
  }
}
