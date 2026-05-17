/**
 * Lifecycle states used by the various Pinia stores.
 *
 * Pattern follows thunderbird/appointment: a single enum-typed status field
 * per concern, rather than a fanout of independent booleans. UI components
 * derive presentation from these states (no DOM mutation in stores).
 */

export const AUTH_STATE = Object.freeze({
  IDLE: 'idle',
  OIDC_LOADING: 'oidc_loading',
  OIDC_READY: 'oidc_ready',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  FAILED: 'failed',
});

export const SYNC_STATE = Object.freeze({
  IDLE: 'idle',
  CONNECTING: 'connecting',
  ACTIVE: 'active',
  RECONNECTING: 'reconnecting',
  STOPPED: 'stopped',
  FAILED: 'failed',
});

export const COMPOSE_STATE = Object.freeze({
  IDLE: 'idle',
  EDITING: 'editing',
  SENDING: 'sending',
  SENT: 'sent',
  FAILED: 'failed',
});

export const MUTATION_STATUS = Object.freeze({
  PENDING: 'pending',
  IN_FLIGHT: 'in_flight',
  RETRY: 'retry',
  CONFLICTED: 'conflicted',
  FAILED: 'failed',
});

export const SYNC_JOB_STATUS = Object.freeze({
  PENDING: 'pending',
  IN_FLIGHT: 'in_flight',
  RETRY: 'retry',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

/**
 * service_kind values stored on account_services rows. Matches the spec.
 */
export const SERVICE_KIND = Object.freeze({
  JMAP_MAIL: 'jmap-mail',
  JMAP_CONTACTS: 'jmap-contacts',
  JMAP_CALENDARS: 'jmap-calendars',
  CARDDAV: 'carddav',
  CALDAV: 'caldav',
  IMAP: 'imap',
});

/**
 * Folder roles as used by JMAP RFC 8621 and IMAP SPECIAL-USE (RFC 6154).
 * Stored lowercase per RFC 8621 §2.
 */
export const FOLDER_ROLE = Object.freeze({
  INBOX: 'inbox',
  SENT: 'sent',
  DRAFTS: 'drafts',
  TRASH: 'trash',
  JUNK: 'junk',
  ARCHIVE: 'archive',
  IMPORTANT: 'important',
  FLAGGED: 'flagged',
  ALL: 'all',
});

/**
 * Standard JMAP keywords ($-prefixed in JMAP, \-prefixed in IMAP).
 */
export const KEYWORD = Object.freeze({
  SEEN: '$seen',
  FLAGGED: '$flagged',
  ANSWERED: '$answered',
  DRAFT: '$draft',
  FORWARDED: '$forwarded',
  JUNK: '$junk',
  NOTJUNK: '$notjunk',
  PHISHING: '$phishing',
});

/**
 * JMAP type names that the sync engine subscribes to over WebSocket push.
 */
export const JMAP_TYPE = Object.freeze({
  MAILBOX: 'Mailbox',
  EMAIL: 'Email',
  THREAD: 'Thread',
  IDENTITY: 'Identity',
  EMAIL_SUBMISSION: 'EmailSubmission',
  EMAIL_DELIVERY: 'EmailDelivery',
  ADDRESSBOOK: 'AddressBook',
  CONTACT_CARD: 'ContactCard',
});
