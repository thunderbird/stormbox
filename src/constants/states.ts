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
export const MUTATION_TYPE = {
  SET_KEYWORDS: 'setKeywords',
  MOVE_TO_FOLDERS: 'moveToFolders',
  DESTROY: 'destroy',
  SEND: 'send',
} as const;
export type MutationType = (typeof MUTATION_TYPE)[keyof typeof MUTATION_TYPE];

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
  | 'ContactCard';

/**
 * `sort: [{ property }]` value for an Email/query mailbox-window view.
 * Maps to the `sort_received_at` / `sort_sent_at` columns on
 * folder_messages.
 */
export type JmapViewSort = 'received' | 'sent';
