/**
 * SQLite row shapes returned by the worker handlers. Field names match
 * the column names verbatim so a row is the SELECT result.
 *
 * Most rows include a few "convenience" fields the handlers add via
 * JOINs (e.g. `view_position`, `index_total`); those live on the
 * top-level type as optional.
 */

import type { MailboxRole, MutationStatus, MutationType, ServiceKind, SyncJobStatus } from '../constants/states';

export interface AccountRow {
  id: number;
  display_name: string | null;
  primary_email: string | null;
  server_origin: string;
  remote_account_id: string;
  server_kind: string | null;
  is_primary: 0 | 1;
  is_personal: 0 | 1;
  created_at: number;
  updated_at: number;
  last_opened_at: number | null;
  quota_used_bytes: number | null;
  quota_hard_limit_bytes: number | null;
  quota_updated_at: number | null;
}

export interface FolderRow {
  id: number;
  account_id: number;
  remote_id: string;
  parent_id: number | null;
  name: string;
  role: MailboxRole | null;
  sort_order: number;
  total_emails: number | null;
  unread_emails: number | null;
  total_threads: number | null;
  unread_threads: number | null;
  may_read_items: 0 | 1 | null;
  may_add_items: 0 | 1 | null;
  may_remove_items: 0 | 1 | null;
  rights_json: string | null;
  raw_json: string | null;
  is_subscribed: 0 | 1 | null;
  is_deleted: 0 | 1;
  updated_at: number;
  // populated by the mail-store after queryViewProgress lands
  index_total?: number;
  index_covered?: number;
  index_percent?: number;
}

export interface IdentityRow {
  id: number;
  account_id: number;
  remote_id: string;
  name: string | null;
  email: string;
  reply_to_json: string | null;
  raw_json: string | null;
  updated_at: number;
}

export interface MessageRow {
  id: number;
  account_id: number;
  remote_id: string;
  thread_id: number | null;
  remote_thread_id: string | null;
  blob_id: string | null;
  rfc822_message_id: string | null;
  in_reply_to_json: string | null;
  references_json: string | null;
  subject: string | null;
  preview: string | null;
  size: number | null;
  received_at: number | null;
  sent_at: number | null;
  has_attachment: 0 | 1;
  keywords_json: string;
  is_seen: 0 | 1;
  is_flagged: 0 | 1;
  is_answered: 0 | 1;
  is_draft: 0 | 1;
  is_forwarded: 0 | 1;
  is_junk: 0 | 1;
  from_text: string | null;
  to_text: string | null;
  raw_json: string | null;
  stale: 0 | 1;
  body_fetched_at: number | null;
  metadata_fetched_at: number | null;
  updated_at: number;
  view_position?: number;
}

export interface BodyAttachmentRow {
  part_id: string;
  blob_id: string | null;
  name: string | null;
  mime_type: string | null;
  size: number | null;
  disposition: string | null;
  cid: string | null;
}

export interface MessageBody {
  text: string;
  html: string;
  attachments: BodyAttachmentRow[];
}

export interface AddressbookRow {
  id: number;
  account_id: number;
  service_kind: ServiceKind;
  remote_id: string;
  name: string | null;
  description: string | null;
  is_default: 0 | 1;
  is_subscribed: 0 | 1;
  ctag: string | null;
  sync_token: string | null;
  raw_json: string | null;
  is_deleted: 0 | 1;
  updated_at: number;
}

export interface ContactListRow {
  id: number;
  remote_id: string | null;
  addressbook_id: number | null;
  display_name: string | null;
  organization: string | null;
  email: string | null;
}

export interface PendingMutationRow {
  id: number;
  account_id: number;
  mutation_type: MutationType;
  local_status: MutationStatus;
  target_message_id: number | null;
  request_json: string;
  optimistic_patch_json: string | null;
  server_response_json: string | null;
  error_json: string | null;
  attempts: number;
  last_attempt_at: number | null;
  not_before: number | null;
  created_at: number;
  updated_at: number;
}

export interface SyncJobRow {
  id: number;
  account_id: number;
  job_type: string;
  priority: number;
  payload_json: string;
  status: SyncJobStatus;
  attempts: number;
  not_before: number | null;
  created_at: number;
  updated_at: number;
}

export interface SyncStateRow {
  account_id: number;
  object_type: string;
  scope: string;
  state: string;
  updated_at: number;
}

export interface QueryViewProgress {
  total: number;
  covered: number;
  percent: number;
}

export interface FolderUpsertInput {
  remoteId: string;
  parentId?: number | null;
  name: string;
  role?: MailboxRole | null;
  sortOrder?: number;
  totalEmails?: number | null;
  unreadEmails?: number | null;
  totalThreads?: number | null;
  unreadThreads?: number | null;
  mayReadItems?: boolean | null;
  mayAddItems?: boolean | null;
  mayRemoveItems?: boolean | null;
  rightsJson?: string | null;
  rawJson?: string | null;
  isSubscribed?: boolean | null;
  isDeleted?: boolean;
}
