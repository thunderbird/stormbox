/**
 * The real, top-level `Scheduled` mailbox that holds Send Later messages.
 *
 * It is an ordinary server mailbox — visible to IMAP clients, synced by
 * the normal Mailbox pipeline — whose only special treatment is that
 * Stormbox keeps it subscribed after adopting or creating it.
 *
 * Discovery order: the settings-cached remote id, then a name match on
 * the shape in `matchesScheduledMailboxShape`, then creation. The cached
 * id is canonical; name matching is bootstrap and recovery only.
 */

import {
  matchesScheduledMailboxShape,
  SCHEDULED_MAILBOX_NAME,
} from '../../../constants/scheduled-mailbox';
import { MUTATION_TYPE } from '../../../constants/states';
import { DB_RPC } from '../../../db/protocol';
import { wlog } from '../../../db/worker-log';
import { callJmap, pickResponse, requireResponse } from './invoke';
import { JMAP_CAPS } from './transport';

const CREATION_ID = 'stormbox-scheduled';

interface ScheduledMailboxArgs {
  transport: any;
  account: { id: number; remote_account_id: string };
  handlers: Record<string, (params: any) => Promise<any>>;
  useWebSocket?: boolean;
}

/** The settings-cached canonical remote id, or null before discovery. */
export async function readScheduledMailboxRemoteId(
  handlers: ScheduledMailboxArgs['handlers'],
  accountId: number,
): Promise<string | null> {
  const current = await handlers[DB_RPC.SETTINGS_GET]({ accountId });
  const cached = current?.doc?.settings?.scheduledMailboxRemoteId;
  return typeof cached === 'string' && cached.length > 0 ? cached : null;
}

async function readVerifiedCachedMailbox(
  { transport, account, useWebSocket }: ScheduledMailboxArgs,
  remoteId: string,
): Promise<DiscoveredMailbox | null> {
  const got = requireResponse(await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
    methodCalls: [[
      'Mailbox/get',
      {
        accountId: account.remote_account_id,
        ids: [remoteId],
        properties: ['id', 'name', 'parentId', 'role', 'isSubscribed'],
      },
      'sm-verify',
    ]],
    useWebSocket,
  }), 'Mailbox/get');
  const mailbox = Array.isArray(got.list)
    ? got.list.find((candidate: any) => candidate?.id === remoteId)
    : null;
  if (!matchesScheduledMailboxShape(mailbox)) return null;
  return {
    remoteId,
    isSubscribed:
      typeof mailbox.isSubscribed === 'boolean' ? mailbox.isSubscribed : null,
  };
}

interface DiscoveredMailbox {
  remoteId: string;
  isSubscribed: boolean | null;
}

/**
 * Find an adoptable `Scheduled` mailbox by name. Returns null when no
 * mailbox carries the name; throws when one does but its shape is wrong,
 * because creating a sibling would collide with the server's unique-name
 * constraint and silently adopting it could commandeer a user folder.
 */
async function discoverByName(
  { transport, account, useWebSocket }: ScheduledMailboxArgs,
): Promise<DiscoveredMailbox | null> {
  const payload = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
    methodCalls: [
      [
        'Mailbox/query',
        {
          accountId: account.remote_account_id,
          filter: { name: SCHEDULED_MAILBOX_NAME },
        },
        'sm-query',
      ],
      [
        'Mailbox/get',
        {
          accountId: account.remote_account_id,
          '#ids': { resultOf: 'sm-query', name: 'Mailbox/query', path: '/ids' },
          properties: ['id', 'name', 'parentId', 'role', 'isSubscribed'],
        },
        'sm-get',
      ],
    ],
    useWebSocket,
  });
  requireResponse(payload, 'Mailbox/query');
  const got = requireResponse(payload, 'Mailbox/get');
  // The name filter can legitimately match nested folders the user made;
  // only the exact top-level shape is ours to manage.
  const candidates = (Array.isArray(got.list) ? got.list : [])
    .filter((m: any) => m?.name === SCHEDULED_MAILBOX_NAME);
  const match = candidates.find(matchesScheduledMailboxShape);
  if (match?.id) {
    return {
      remoteId: match.id,
      isSubscribed: typeof match.isSubscribed === 'boolean' ? match.isSubscribed : null,
    };
  }
  if (candidates.some((m: any) => m?.parentId == null)) {
    const error: any = new Error(
      `A top-level mailbox named ${SCHEDULED_MAILBOX_NAME} exists but has a `
      + 'special role, so it cannot hold scheduled messages.',
    );
    error.type = 'scheduledMailboxConflict';
    error.terminal = true;
    throw error;
  }
  return null;
}

async function createMailbox(
  args: ScheduledMailboxArgs,
): Promise<DiscoveredMailbox> {
  const { transport, account, useWebSocket } = args;
  const payload = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
    methodCalls: [[
      'Mailbox/set',
      {
        accountId: account.remote_account_id,
        create: {
          [CREATION_ID]: {
            name: SCHEDULED_MAILBOX_NAME,
            parentId: null,
            isSubscribed: true,
          },
        },
      },
      'sm-create',
    ]],
    useWebSocket,
  });
  const response = pickResponse(payload, 'Mailbox/set');
  const createdId = response?.created?.[CREATION_ID]?.id;
  if (typeof createdId === 'string' && createdId.length > 0) {
    return { remoteId: createdId, isSubscribed: true };
  }
  // A lost race with another client leaves the name taken; adopt theirs.
  const discovered = await discoverByName(args);
  if (discovered) return discovered;
  const failure = response?.notCreated?.[CREATION_ID];
  throw new Error(
    `Could not create the ${SCHEDULED_MAILBOX_NAME} mailbox`
    + `${failure?.type ? ` (${failure.type})` : ''}`,
  );
}

/**
 * Mirror the mailbox into the local folders table right away so filing
 * and folder lookups work before the next full Mailbox sync runs. The
 * regular sync refreshes counts and subscription afterwards.
 */
async function upsertLocalFolder(
  { handlers, account }: ScheduledMailboxArgs,
  remoteId: string,
  isSubscribed: boolean | null,
): Promise<void> {
  const [updated] = await handlers[DB_RPC.TRANSACTION]({
    statements: [{
      sql: `UPDATE folders
               SET parent_id = NULL, name = ?, role = NULL,
                   is_subscribed = COALESCE(?, is_subscribed),
                   is_deleted = 0, updated_at = ?
             WHERE account_id = ? AND remote_id = ?`,
      params: [
        SCHEDULED_MAILBOX_NAME,
        isSubscribed,
        Date.now(),
        account.id,
        remoteId,
      ],
    }],
  });
  if (Number(updated?.changes ?? 0) > 0) return;
  await handlers[DB_RPC.FOLDER_UPSERT_MANY]({
    accountId: account.id,
    folders: [{
      remoteId,
      parentId: null,
      name: SCHEDULED_MAILBOX_NAME,
      role: null,
      isSubscribed,
    }],
  });
}

/**
 * Resolve the Scheduled mailbox's remote id, creating the mailbox when
 * the account has none. Idempotent; safe on every send retry.
 */
export async function ensureScheduledMailbox(
  args: ScheduledMailboxArgs,
): Promise<string> {
  const { handlers, account } = args;
  const cached = await readScheduledMailboxRemoteId(handlers, account.id);
  const verified = cached
    ? await readVerifiedCachedMailbox(args, cached)
    : null;
  if (verified) {
    await upsertLocalFolder(args, verified.remoteId, verified.isSubscribed);
    return verified.remoteId;
  }

  const mailbox = await discoverByName(args) ?? await createMailbox(args);
  await upsertLocalFolder(args, mailbox.remoteId, mailbox.isSubscribed);
  if (mailbox.remoteId !== cached) {
    await handlers[DB_RPC.SETTINGS_APPLY_PATCH]({
      accountId: account.id,
      patch: { scheduledMailboxRemoteId: mailbox.remoteId },
    });
  }
  return mailbox.remoteId;
}

/**
 * Keep the managed mailbox subscribed. Runs after scheduling transitions
 * and rewrites any queued legacy/opposite subscription write so retries
 * converge on permanent visibility.
 *
 * Best-effort by design — the subscription only controls folder-pane
 * visibility, and every caller sits past a point of no return where a
 * cosmetic failure must not fail the row.
 */
export async function reconcileScheduledSubscription(
  handlers: ScheduledMailboxArgs['handlers'],
  accountId: number,
): Promise<void> {
  try {
    const remoteId = await readScheduledMailboxRemoteId(handlers, accountId);
    if (!remoteId) return;
    const rows = await handlers[DB_RPC.QUERY]({
      sql: `SELECT f.id AS folder_id,
                   COALESCE(f.is_subscribed, 1) AS is_subscribed
              FROM folders f
             WHERE f.account_id = ? AND f.remote_id = ? AND f.is_deleted = 0`,
      params: [accountId, remoteId],
    });
    const row = rows?.[0];
    if (!row) return;
    const desired = true;
    const current = Number(row.is_subscribed) !== 0;
    const pending = await handlers[DB_RPC.QUERY]({
      sql: `SELECT id, local_status, request_json
              FROM pending_mutations
             WHERE account_id = ? AND mutation_type = ?
               AND local_status IN ('pending', 'in_flight', 'retry')
             ORDER BY id`,
      params: [accountId, MUTATION_TYPE.SET_MAILBOX_SUBSCRIPTION],
    });
    let queuedDesired = false;
    let inFlightDesired = false;
    let inFlightOpposite = false;
    for (const mutation of pending ?? []) {
      let request: any;
      try {
        request = JSON.parse(mutation.request_json);
      } catch {
        continue;
      }
      const operations = Array.isArray(request?.operations)
        ? request.operations
        : [request];
      const matches = operations.some(
        (operation: any) => Number(operation?.folderId) === Number(row.folder_id),
      );
      if (!matches) continue;
      if (mutation.local_status === 'in_flight') {
        const intended = operations
          .filter((operation: any) => Number(operation?.folderId) === Number(row.folder_id))
          .at(-1)?.isSubscribed === true;
        if (intended === desired) inFlightDesired = true;
        else inFlightOpposite = true;
        continue;
      }

      const rewritten = {
        ...request,
        ...(Array.isArray(request?.operations)
          ? {
              operations: operations.map((operation: any) =>
                Number(operation?.folderId) === Number(row.folder_id)
                  ? { ...operation, isSubscribed: desired }
                  : operation),
            }
          : { isSubscribed: desired }),
      };
      const [updated] = await handlers[DB_RPC.TRANSACTION]({
        statements: [{
          sql: `UPDATE pending_mutations
                   SET request_json = ?, local_status = 'pending',
                       attempts = 0, not_before = NULL, error_json = NULL,
                       updated_at = ?
                 WHERE id = ? AND local_status IN ('pending', 'retry')`,
          params: [JSON.stringify(rewritten), Date.now(), Number(mutation.id)],
        }],
      });
      if (Number(updated?.changes ?? 0) > 0) queuedDesired = true;
      else inFlightOpposite = true;
    }
    if (queuedDesired) return;
    if (inFlightDesired && !inFlightOpposite) return;
    if (desired === current && !inFlightOpposite) return;
    await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
      accountId,
      mutationType: MUTATION_TYPE.SET_MAILBOX_SUBSCRIPTION,
      targetMessageId: null,
      requestJson: JSON.stringify({
        folderId: Number(row.folder_id),
        isSubscribed: desired,
        managedBy: 'scheduledMailbox',
      }),
      optimisticPatchJson: null,
    });
  } catch (error: any) {
    wlog.warn(
      'jmap-scheduled-mailbox',
      `scheduled subscription reconcile failed: ${error?.message ?? error}`,
    );
  }
}
