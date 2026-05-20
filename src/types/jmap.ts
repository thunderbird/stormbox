/**
 * Minimal JMAP protocol shapes used at module boundaries.
 *
 * These are not exhaustive RFC 8620/8621 type definitions — only the
 * fields stormbox actually reads or writes are typed. The rest are
 * passed through as `unknown` / `Record<string, unknown>` so the type
 * system doesn't pretend to validate the wire shape.
 */

import type { Keyword, JmapType, JmapViewSort, MailboxRole } from '../constants/states';

// ---------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------

export interface JmapSession {
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  eventSourceUrl?: string;
  capabilities: Record<string, unknown>;
  primaryAccounts: Record<string, string | undefined>;
  accounts: Record<string, JmapSessionAccount>;
  state?: string;
  username?: string;
  websocketUrl?: string;
  supportsWebSocketPush?: boolean;
}

export interface JmapSessionAccount {
  name: string;
  isPersonal: boolean;
  isReadOnly: boolean;
  accountCapabilities: Record<string, unknown>;
}

// ---------------------------------------------------------------------
// Mailbox
// ---------------------------------------------------------------------

export interface JmapMailbox {
  id: string;
  name: string;
  parentId: string | null;
  role: MailboxRole | null;
  sortOrder: number;
  totalEmails?: number;
  unreadEmails?: number;
  totalThreads?: number;
  unreadThreads?: number;
  myRights?: Record<string, boolean>;
}

// ---------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------

export interface JmapEmailAddress {
  name?: string | null;
  email: string;
}

export interface JmapEmail {
  id: string;
  blobId: string;
  threadId?: string;
  mailboxIds: Record<string, true>;
  keywords: Partial<Record<Keyword, true>> & Record<string, true>;
  size?: number;
  receivedAt?: string;
  sentAt?: string;
  messageId?: string[];
  inReplyTo?: string[];
  references?: string[];
  from?: JmapEmailAddress[];
  to?: JmapEmailAddress[];
  cc?: JmapEmailAddress[];
  bcc?: JmapEmailAddress[];
  sender?: JmapEmailAddress[];
  subject?: string;
  preview?: string;
  hasAttachment?: boolean;
  textBody?: JmapEmailBodyPart[];
  htmlBody?: JmapEmailBodyPart[];
  attachments?: JmapEmailBodyPart[];
  bodyValues?: Record<string, JmapBodyValue>;
  [key: string]: unknown;
}

export interface JmapEmailBodyPart {
  partId?: string;
  blobId?: string;
  type?: string;
  name?: string;
  size?: number;
  disposition?: string;
  cid?: string;
  charset?: string;
}

export interface JmapBodyValue {
  value: string;
  isEncodingProblem?: boolean;
  isTruncated?: boolean;
}

// ---------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------

export interface JmapIdentity {
  id: string;
  name: string;
  email: string;
  replyTo?: JmapEmailAddress[] | null;
  bcc?: JmapEmailAddress[] | null;
  textSignature?: string | null;
  htmlSignature?: string | null;
  mayDelete?: boolean;
}

// ---------------------------------------------------------------------
// Email/query and Email/queryChanges
// ---------------------------------------------------------------------

export interface JmapQueryRequest {
  filter?: { inMailbox?: string; [key: string]: unknown };
  sort?: Array<{ property: JmapViewSort | string; isAscending?: boolean }>;
  collapseThreads?: boolean;
  limit?: number;
  position?: number;
  calculateTotal?: boolean;
}

export interface JmapQueryResponse {
  ids: string[];
  position: number;
  total?: number;
  queryState?: string;
  canCalculateChanges?: boolean;
}

// ---------------------------------------------------------------------
// State change frame
// ---------------------------------------------------------------------

export interface JmapStateChange {
  '@type': 'StateChange';
  changed: Record<string, Partial<Record<JmapType, string>>>;
  pushState?: string;
}

// ---------------------------------------------------------------------
// Address book / contacts
// ---------------------------------------------------------------------

export interface JmapAddressBook {
  id: string;
  name?: string | null;
  description?: string | null;
  isDefault?: boolean;
  isSubscribed?: boolean;
  myRights?: Record<string, boolean>;
}

export interface JmapContactCard {
  id: string;
  uid?: string;
  fullName?: string;
  name?: { surnames?: string; given?: string };
  organizations?: Record<string, { name?: string }>;
  emails?: Record<string, { address: string; pref?: number }>;
  [key: string]: unknown;
}
