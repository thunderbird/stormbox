/**
 * pending_mutations helpers for outbox unit suites: enqueue a request the
 * way the store does and read a row back as the drain would see it.
 */

import { DB_RPC } from '../../../src/db/protocol';

type Handlers = Record<string, (params: any) => Promise<any>>;

export interface QueuePendingMutationOptions {
  accountId: number;
  mutationType: string;
  request: Record<string, unknown>;
  targetMessageId?: number | null;
}

/** Latest persisted state of one pending_mutations row, or null if gone. */
export async function reloadPendingMutation(handlers: Handlers, id: number) {
  const rows = await handlers[DB_RPC.QUERY]({
    sql: 'SELECT * FROM pending_mutations WHERE id = ?',
    params: [id],
  });
  return rows[0] ?? null;
}

/** Insert a pending mutation and return the stored row. */
export async function queuePendingMutation(handlers: Handlers, {
  accountId,
  mutationType,
  request,
  targetMessageId = null,
}: QueuePendingMutationOptions) {
  const { id } = await handlers[DB_RPC.PENDING_MUTATION_INSERT]({
    accountId,
    mutationType,
    targetMessageId,
    requestJson: JSON.stringify(request),
  });
  return reloadPendingMutation(handlers, id);
}
