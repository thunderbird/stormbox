/**
 * The `Scheduled` mailbox that holds Send Later messages: the JMAP role
 * folder `scheduled` (RFC 9979 §8.2). It is an ordinary server mailbox
 * synced by the normal Mailbox pipeline, and every consumer identifies
 * it by `folders.role`, exactly like Drafts or Sent.
 *
 * Stalwart does not create the role folder by default, so the first
 * scheduled send does. Discovery order: the local role folder, the
 * server's role folder, a roleless top-level mailbox already named
 * `Scheduled` (adopted by setting its role, since a same-named sibling
 * cannot be created), then creation.
 */

import { DB_RPC } from '../../../db/protocol';
import { callJmap, pickResponse, requireResponse } from './invoke';
import { maxObjectsInGet } from './limits';
import { pageCompleteQuery } from './query-paging';
import { JMAP_CAPS } from './transport';

export const SCHEDULED_MAILBOX_NAME = 'Scheduled';
export const SCHEDULED_MAILBOX_ROLE = 'scheduled';

const CREATION_ID = 'stormbox-scheduled';
const MAILBOX_PROPERTIES = ['id', 'name', 'parentId', 'role', 'isSubscribed'];

interface ScheduledMailboxArgs {
  transport: any;
  account: { id: number; remote_account_id: string };
  handlers: Record<string, (params: any) => Promise<any>>;
  useWebSocket?: boolean;
}

interface DiscoveredMailbox {
  remoteId: string;
  isSubscribed: boolean | null;
}

/** Remote id of the local `scheduled` role folder, or null before it exists. */
export async function scheduledMailboxRemoteId(
  handlers: ScheduledMailboxArgs['handlers'],
  accountId: number,
): Promise<string | null> {
  const row = await handlers[DB_RPC.FOLDER_BY_ROLE]({
    accountId,
    role: SCHEDULED_MAILBOX_ROLE,
  });
  const remoteId = row?.remote_id;
  return typeof remoteId === 'string' && remoteId.length > 0 ? remoteId : null;
}

function toDiscovered(mailbox: any): DiscoveredMailbox {
  return {
    remoteId: mailbox.id,
    isSubscribed: typeof mailbox.isSubscribed === 'boolean' ? mailbox.isSubscribed : null,
  };
}

/** The server's `scheduled` role folder; a role is unique per account (RFC 8621 §2). */
async function discoverByRole(
  { transport, account, useWebSocket }: ScheduledMailboxArgs,
): Promise<DiscoveredMailbox | null> {
  const payload = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
    methodCalls: [
      [
        'Mailbox/query',
        {
          accountId: account.remote_account_id,
          filter: { role: SCHEDULED_MAILBOX_ROLE },
          limit: 1,
        },
        'sm-role-query',
      ],
      [
        'Mailbox/get',
        {
          accountId: account.remote_account_id,
          '#ids': { resultOf: 'sm-role-query', name: 'Mailbox/query', path: '/ids' },
          properties: MAILBOX_PROPERTIES,
        },
        'sm-role-get',
      ],
    ],
    useWebSocket,
  });
  requireResponse(payload, 'Mailbox/query');
  const got = requireResponse(payload, 'Mailbox/get');
  const match = Array.isArray(got.list)
    ? got.list.find((mailbox: any) => mailbox?.role === SCHEDULED_MAILBOX_ROLE && mailbox?.id)
    : null;
  return match ? toDiscovered(match) : null;
}

/** Every mailbox named `Scheduled`, at any depth. */
async function listByName(
  { transport, account, useWebSocket }: ScheduledMailboxArgs,
): Promise<any[]> {
  const candidates: any[] = [];
  const paging = await pageCompleteQuery({
    pageSize: maxObjectsInGet(transport),
    readPage: async ({ page, position, limit }) => {
      const queryCallId = `sm-query-${page}`;
      const getCallId = `sm-get-${page}`;
      const payload = await callJmap(transport, {
        using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
        methodCalls: [
          [
            'Mailbox/query',
            {
              accountId: account.remote_account_id,
              filter: { name: SCHEDULED_MAILBOX_NAME },
              position,
              limit,
              calculateTotal: true,
            },
            queryCallId,
          ],
          [
            'Mailbox/get',
            {
              accountId: account.remote_account_id,
              '#ids': { resultOf: queryCallId, name: 'Mailbox/query', path: '/ids' },
              properties: MAILBOX_PROPERTIES,
            },
            getCallId,
          ],
        ],
        useWebSocket,
      });
      const query = requireResponse(payload, 'Mailbox/query');
      const got = requireResponse(payload, 'Mailbox/get');
      if (!Array.isArray(query.ids) || !Array.isArray(got.list)) {
        throw new Error('Scheduled mailbox discovery returned a malformed page');
      }
      const returned = new Set(got.list.map((mailbox: any) => mailbox?.id));
      if (query.ids.some((id: unknown) => !returned.has(id))) {
        throw new Error('Scheduled mailbox discovery omitted a queried mailbox');
      }
      return {
        ids: query.ids,
        queryState: typeof query.queryState === 'string' ? query.queryState : null,
        total:
          typeof query.total === 'number' && Number.isSafeInteger(query.total)
            ? query.total
            : null,
        limit: query.limit,
        value: got.list,
      };
    },
    visitPage: ({ value: list }) => {
      candidates.push(...list.filter(
        (mailbox: any) => mailbox?.name === SCHEDULED_MAILBOX_NAME,
      ));
    },
  });
  if (paging.complete === false) {
    throw new Error(`Scheduled mailbox discovery did not complete (${paging.reason})`);
  }
  return candidates;
}

/**
 * Adopt a roleless top-level `Scheduled` mailbox by giving it the role.
 * Returns null when no top-level mailbox carries the name (nested
 * user folders are left alone); throws a terminal conflict when the
 * top-level one has some other role, because a same-named sibling
 * cannot be created and a role folder cannot be repurposed.
 */
async function adoptByName(args: ScheduledMailboxArgs): Promise<DiscoveredMailbox | null> {
  const { transport, account, useWebSocket } = args;
  const topLevel = (await listByName(args)).filter((mailbox: any) => mailbox?.parentId == null);
  if (topLevel.length === 0) return null;
  const withRole = topLevel.find((mailbox: any) => mailbox.role === SCHEDULED_MAILBOX_ROLE);
  if (withRole) return toDiscovered(withRole);
  const roleless = topLevel.find((mailbox: any) => mailbox.role == null && mailbox.id);
  if (!roleless) {
    const error: any = new Error(
      `A top-level mailbox named ${SCHEDULED_MAILBOX_NAME} exists but has a `
      + 'different special role, so it cannot hold scheduled messages.',
    );
    error.type = 'scheduledMailboxConflict';
    error.terminal = true;
    throw error;
  }
  const payload = await callJmap(transport, {
    using: [JMAP_CAPS.CORE, JMAP_CAPS.MAIL],
    methodCalls: [[
      'Mailbox/set',
      {
        accountId: account.remote_account_id,
        update: { [roleless.id]: { role: SCHEDULED_MAILBOX_ROLE } },
      },
      'sm-adopt',
    ]],
    useWebSocket,
  });
  const response = pickResponse(payload, 'Mailbox/set');
  if (response?.updated && roleless.id in response.updated) {
    return toDiscovered(roleless);
  }
  const failure = response?.notUpdated?.[roleless.id];
  throw new Error(
    `Could not set the ${SCHEDULED_MAILBOX_ROLE} role on the ${SCHEDULED_MAILBOX_NAME} mailbox`
    + `${failure?.type ? ` (${failure.type})` : ''}`,
  );
}

async function createMailbox(args: ScheduledMailboxArgs): Promise<DiscoveredMailbox> {
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
            role: SCHEDULED_MAILBOX_ROLE,
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
  // A lost race with another client leaves the role or name taken.
  const discovered = await discoverByRole(args) ?? await adoptByName(args);
  if (discovered) return discovered;
  const failure = response?.notCreated?.[CREATION_ID];
  throw new Error(
    `Could not create the ${SCHEDULED_MAILBOX_NAME} mailbox`
    + `${failure?.type ? ` (${failure.type})` : ''}`,
  );
}

/**
 * Mirror the mailbox into the local folders table right away so filing
 * and role lookups work before the next Mailbox sync runs. The regular
 * sync refreshes counts and subscription afterwards.
 */
async function upsertLocalFolder(
  { handlers, account }: ScheduledMailboxArgs,
  remoteId: string,
  isSubscribed: boolean | null,
): Promise<void> {
  const [updated] = await handlers[DB_RPC.TRANSACTION]({
    statements: [{
      sql: `UPDATE folders
               SET parent_id = NULL, name = ?, role = ?,
                   is_subscribed = COALESCE(?, is_subscribed),
                   is_deleted = 0, updated_at = ?
             WHERE account_id = ? AND remote_id = ?`,
      params: [
        SCHEDULED_MAILBOX_NAME,
        SCHEDULED_MAILBOX_ROLE,
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
      role: SCHEDULED_MAILBOX_ROLE,
      isSubscribed,
    }],
  });
}

/**
 * Resolve the Scheduled mailbox's remote id, creating the mailbox when
 * the account has none. Idempotent; safe on every send retry.
 */
export async function ensureScheduledMailbox(args: ScheduledMailboxArgs): Promise<string> {
  const { handlers, account } = args;
  const local = await scheduledMailboxRemoteId(handlers, account.id);
  if (local) return local;

  const mailbox = await discoverByRole(args)
    ?? await adoptByName(args)
    ?? await createMailbox(args);
  await upsertLocalFolder(args, mailbox.remoteId, mailbox.isSubscribed);
  return mailbox.remoteId;
}
