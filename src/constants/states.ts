/**
 * Lifecycle constants and string-literal types used across stormbox.
 *
 * Two patterns coexist here:
 *
 *   1. stormbox-internal state machines (auth, sync, compose, mutation
 *      lifecycle, sync jobs, service kinds) export an `as const` object.
 *      Code uses `AUTH_STATE.CONNECTED` so a typo at a call site is a
 *      compile error and the legal set is centralised. Each object has
 *      a derived string-literal type (`AuthState`, etc.) for parameter
 *      / state typing.
 *
 *   2. Protocol values defined by JMAP / IMAP RFCs (folder roles,
 *      keywords, JMAP type names, view sort properties) are exposed as
 *      string-literal *types* only. Code uses the literal at the call
 *      site (`f.role === 'inbox'`) — same value flows through network,
 *      worker, store, and UI without translation. The type still
 *      catches typos at compile time.
 *
 * `MUTATION_TYPE` and `VIEW_TYPE` are stormbox-internal too even
 * though they shape JMAP payloads — the strings are local labels we
 * chose, not protocol values.
 */

// ---------------------------------------------------------------------
// stormbox-internal state machines
// ---------------------------------------------------------------------

export const AUTH_STATE = {
  IDLE: 'idle',
  OIDC_LOADING: 'oidc_loading',
  OIDC_READY: 'oidc_ready',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  FAILED: 'failed',
} as const;
export type AuthState = (typeof AUTH_STATE)[keyof typeof AUTH_STATE];

export const SYNC_STATE = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  ACTIVE: 'active',
  RECONNECTING: 'reconnecting',
  STOPPED: 'stopped',
  FAILED: 'failed',
} as const;
export type SyncState = (typeof SYNC_STATE)[keyof typeof SYNC_STATE];

export const COMPOSE_STATE = {
  IDLE: 'idle',
  EDITING: 'editing',
  SENDING: 'sending',
  SENT: 'sent',
  FAILED: 'failed',
} as const;
export type ComposeState = (typeof COMPOSE_STATE)[keyof typeof COMPOSE_STATE];

export const MUTATION_STATUS = {
  PENDING: 'pending',
  IN_FLIGHT: 'in_flight',
  RETRY: 'retry',
  CONFLICTED: 'conflicted',
  FAILED: 'failed',
} as const;
export type MutationStatus = (typeof MUTATION_STATUS)[keyof typeof MUTATION_STATUS];

/**
 * pending_mutations.phase for SEND rows. Records the furthest point known
 * to have succeeded, written before the next protocol call is issued, so
 * a resume can skip work that already happened. Only CREATED and
 * SUBMITTED describe irreversible server state; the rest are local
 * bookkeeping. Contact and Identity writes reuse CACHE_PENDING for their own
 * server-applied-cache-behind windows; contact creates also record a phase
 * while their idempotency key is being reconciled.
 *
 * UNKNOWN is terminal for automation on purpose: it means a response was
 * lost and reconciliation could not decide, so the choice belongs to the
 * user rather than to a retry loop.
 */
export const SEND_PHASE = {
  QUEUED: 'queued',
  CREATED: 'created',
  /**
   * The submission request is about to go out, or is out and unanswered.
   * Written before the call rather than after it, because the window
   * being guarded is the call itself: a worker that dies here may already
   * have had its submission accepted, so this phase must never be
   * replayed. Without it, `created` would have to cover both "not yet
   * submitted" and "submission outcome unknown", and treating that as
   * resumable delivers the message twice.
   */
  SUBMITTING: 'submitting',
  SUBMITTED: 'submitted',
  CACHE_PENDING: 'cache_pending',
  UNKNOWN: 'unknown',
} as const;
export type SendPhase = (typeof SEND_PHASE)[keyof typeof SEND_PHASE];

export const IDENTITY_PHASE = {
  CREATE_SUBMITTING: 'identity_create_submitting',
} as const;
export type IdentityPhase = (typeof IDENTITY_PHASE)[keyof typeof IDENTITY_PHASE];

export const CONTACT_PHASE = {
  CREATE_PENDING: 'contact_create_pending',
} as const;
export type ContactPhase = (typeof CONTACT_PHASE)[keyof typeof CONTACT_PHASE];

export const ADDRESSBOOK_PHASE = {
  CREATE_SUBMITTING: 'addressbook_create_submitting',
  DESTROY_SUBMITTING: 'addressbook_destroy_submitting',
  CACHE_PENDING: 'addressbook_cache_pending',
} as const;
export type AddressBookPhase =
  (typeof ADDRESSBOOK_PHASE)[keyof typeof ADDRESSBOOK_PHASE];

export const CONTACT_TRASH_PHASE = {
  SNAPSHOT_SAVED: 'contact_trash_snapshot_saved',
  DOCUMENT_CONFIRMED: 'contact_trash_document_confirmed',
  SERVER_WRITE_PENDING: 'contact_trash_server_write_pending',
  CACHE_PENDING: 'contact_trash_cache_pending',
  RESTORE_PENDING: 'contact_trash_restore_pending',
  TOMBSTONE_PENDING: 'contact_trash_tombstone_pending',
} as const;
export type ContactTrashPhase =
  (typeof CONTACT_TRASH_PHASE)[keyof typeof CONTACT_TRASH_PHASE];

export const DRAFT_PHASE = {
  QUEUED: 'draft_queued',
  CREATED: 'draft_created',
  CACHE_PENDING: 'draft_cache_pending',
  CLEANUP_PENDING: 'draft_cleanup_pending',
  CONFLICT: 'draft_conflict',
} as const;
export type DraftPhase = (typeof DRAFT_PHASE)[keyof typeof DRAFT_PHASE];
export type MutationPhase =
  | SendPhase
  | DraftPhase
  | IdentityPhase
  | ContactPhase
  | AddressBookPhase
  | ContactTrashPhase;

export const SYNC_JOB_STATUS = {
  PENDING: 'pending',
  IN_FLIGHT: 'in_flight',
  RETRY: 'retry',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;
export type SyncJobStatus = (typeof SYNC_JOB_STATUS)[keyof typeof SYNC_JOB_STATUS];

/**
 * service_kind values stored on account_services rows. Matches the spec.
 */
export const SERVICE_KIND = {
  JMAP_MAIL: 'jmap-mail',
  JMAP_CONTACTS: 'jmap-contacts',
  JMAP_CALENDARS: 'jmap-calendars',
  CARDDAV: 'carddav',
  CALDAV: 'caldav',
  IMAP: 'imap',
} as const;
export type ServiceKind = (typeof SERVICE_KIND)[keyof typeof SERVICE_KIND];

/**
 * pending_mutations.mutation_type. The string is a stormbox label, not
 * a JMAP wire value — the outbox dispatcher maps each one to the right
 * Email/set / EmailSubmission/set call shape.
 */
export const MUTATION_TYPE = Object.freeze({
  SET_KEYWORDS: 'setKeywords',
  MOVE_TO_FOLDERS: 'moveToFolders',
  COPY_TO_FOLDERS: 'copyToFolders',
  DESTROY: 'destroy',
  SEND: 'send',
  CANCEL_SCHEDULED_SEND: 'cancelScheduledSend',
  SAVE_DRAFT: 'saveDraft',
  DISCARD_DRAFT: 'discardDraft',
  WHITELIST_SENDER: 'whitelistSender',
  CREATE_CONTACT: 'createContact',
  UPDATE_CONTACT: 'updateContact',
  DELETE_CONTACT: 'deleteContact',
  CONTACT_BATCH: 'contactBatch',
  CONTACT_TRASH: 'contactTrash',
  CREATE_IDENTITY: 'createIdentity',
  UPDATE_IDENTITY: 'updateIdentity',
  DELETE_IDENTITY: 'deleteIdentity',
  CREATE_ADDRESSBOOK: 'createAddressbook',
  UPDATE_ADDRESSBOOK: 'updateAddressbook',
  DESTROY_ADDRESSBOOK: 'destroyAddressbook',
  SET_MAILBOX_SUBSCRIPTION: 'setMailboxSubscription',
  CREATE_MAILBOX: 'createMailbox',
  UPDATE_MAILBOX: 'updateMailbox',
  DESTROY_MAILBOX: 'destroyMailbox',
  PUSH_SETTINGS: 'pushSettings',
  PUSH_CONTACTS_TRASH: 'pushContactsTrash',
} as const);
export type MutationType = (typeof MUTATION_TYPE)[keyof typeof MUTATION_TYPE];

export interface MutationRecoveryPolicy {
  mutationType: MutationType;
  replayablePhases: readonly MutationPhase[];
  completedPhases: readonly MutationPhase[];
}

export const MUTATION_RECOVERY_POLICIES = [
  {
    mutationType: MUTATION_TYPE.SEND,
    replayablePhases: [SEND_PHASE.QUEUED, SEND_PHASE.CREATED],
    completedPhases: [SEND_PHASE.SUBMITTED, SEND_PHASE.CACHE_PENDING],
  },
  {
    mutationType: MUTATION_TYPE.CREATE_IDENTITY,
    replayablePhases: [IDENTITY_PHASE.CREATE_SUBMITTING],
    completedPhases: [SEND_PHASE.CACHE_PENDING],
  },
  {
    mutationType: MUTATION_TYPE.CREATE_ADDRESSBOOK,
    replayablePhases: [ADDRESSBOOK_PHASE.CREATE_SUBMITTING],
    completedPhases: [ADDRESSBOOK_PHASE.CACHE_PENDING],
  },
  {
    mutationType: MUTATION_TYPE.DESTROY_ADDRESSBOOK,
    replayablePhases: [ADDRESSBOOK_PHASE.DESTROY_SUBMITTING],
    completedPhases: [ADDRESSBOOK_PHASE.CACHE_PENDING],
  },
] as const satisfies readonly MutationRecoveryPolicy[];

/**
 * query_views.view_type. Stormbox-internal label for the cached
 * Email/query result shape; new view types can be added (thread view,
 * search results, etc.) without touching JMAP.
 */
export const VIEW_TYPE = {
  MAILBOX_WINDOW: 'mailbox-window',
} as const;
export type ViewType = (typeof VIEW_TYPE)[keyof typeof VIEW_TYPE];

// ---------------------------------------------------------------------
// Protocol-defined string literals (RFC 8621 / RFC 6154 / JMAP)
// ---------------------------------------------------------------------

/**
 * Folder roles per JMAP RFC 8621 §2 ("role" property on Mailbox) and
 * IMAP SPECIAL-USE (RFC 6154). Stored lowercase per RFC 8621.
 *
 * `null` is a valid value at the protocol level (folder has no role)
 * but stores generally check `f.role === 'inbox'` etc., so we expose
 * the populated set as a union.
 */
export type MailboxRole =
  | 'inbox'
  | 'sent'
  | 'drafts'
  | 'trash'
  | 'junk'
  | 'archive'
  | 'important'
  | 'flagged'
  | 'all';

/**
 * Standard JMAP keywords ($-prefixed in JMAP, \-prefixed in IMAP).
 * Custom keywords are also legal at the protocol level; the union
 * covers the named-set defined in RFC 8621 §4.1.1.
 */
export type Keyword =
  | '$seen'
  | '$flagged'
  | '$answered'
  | '$draft'
  | '$forwarded'
  | '$junk'
  | '$notjunk'
  | '$phishing';

/**
 * JMAP type names that appear in StateChange push frames and
 * Email/get etc. responses. The sync engine subscribes to these by
 * name over the WebSocket.
 */
export type JmapType =
  | 'Mailbox'
  | 'Email'
  | 'Thread'
  | 'Identity'
  | 'EmailSubmission'
  | 'EmailDelivery'
  | 'AddressBook'
  | 'ContactCard'
  | 'FileNode';

/**
 * `sort: [{ property }]` value for an Email/query mailbox-window view.
 * Maps to the `sort_received_at` / `sort_sent_at` columns on
 * folder_messages. `scheduled` is sentAt ascending — the Scheduled
 * mailbox lists the soonest send first.
 */
export type JmapViewSort = 'received' | 'sent' | 'scheduled';
