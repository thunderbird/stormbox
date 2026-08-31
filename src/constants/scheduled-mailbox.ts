/**
 * The Send Later mailbox is a normal, visible, top-level mailbox named
 * `Scheduled`, exactly as conventional IMAP clients see it. Name matching
 * is bootstrap/recovery only: once discovered or created, the remote id
 * cached in the synced settings document (`scheduledMailboxRemoteId`) is
 * the canonical identity every consumer compares against.
 */

export const SCHEDULED_MAILBOX_NAME = 'Scheduled';

/** Bootstrap-time shape check: top-level, roleless, named `Scheduled`. */
export function matchesScheduledMailboxShape(
  mailbox: { name?: unknown; role?: unknown; parentId?: unknown } | null | undefined,
): boolean {
  return mailbox?.name === SCHEDULED_MAILBOX_NAME
    && (mailbox.role == null)
    && (mailbox.parentId == null);
}

/**
 * The one shared predicate for "is this folder the managed Scheduled
 * mailbox". `canonicalRemoteId` is the settings-cached id; a null id
 * matches nothing, so consumers degrade to ordinary-folder behavior
 * until discovery has run.
 */
export function isScheduledMailbox(
  folder: { remote_id?: unknown } | null | undefined,
  canonicalRemoteId: string | null | undefined,
): boolean {
  return typeof canonicalRemoteId === 'string'
    && canonicalRemoteId.length > 0
    && folder?.remote_id === canonicalRemoteId;
}
