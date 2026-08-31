/**
 * SQLite row shapes returned by the worker handlers. Field names match
 * the column names verbatim so a row is the SELECT result.
 *
 * Most rows include a few "convenience" fields the handlers add via
 * JOINs (e.g. `view_position`, `index_total`); those live on the
 * top-level type as optional.
 */

import type {
  MailboxRole, MutationPhase, MutationStatus, MutationType, ServiceKind, SyncJobStatus,
} from '../constants/states';
import type {
  ContactTrashMedia,
  ContactTrashStatus,
} from '../constants/contacts-trash-document';

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
  /** Client-local "pin to top of the folder list"; never synced to JMAP. */
  is_starred: 0 | 1;
  is_deleted: 0 | 1;
  updated_at: number;
  // populated by the mail-store after queryViewProgress lands
  index_total?: number;
  index_covered?: number;
  index_percent?: number;
  /**
   * Mail-store decoration: 1 when this row is the managed Send Later
   * `Scheduled` mailbox (matched against the settings-cached remote id).
   * Never stored in SQLite.
   */
  is_scheduled?: 0 | 1;
}

export interface IdentityAddress {
  name: string | null;
  email: string;
}

export interface IdentityRow {
  id: number;
  account_id: number;
  remote_id: string;
  name: string;
  email: string;
  reply_to_json: string | null;
  bcc_json: string | null;
  text_signature: string | null;
  html_signature: string | null;
  may_delete: 0 | 1 | null;
  raw_json: string | null;
  updated_at: number;
  /** Protocol-neutral values decoded from reply_to_json by the repository handler. */
  reply_to: IdentityAddress[] | null;
  /** Protocol-neutral values decoded from bcc_json by the repository handler. */
  bcc: IdentityAddress[] | null;
}

export interface IdentityMutableFields {
  name?: string;
  replyTo?: IdentityAddress[] | null;
  bcc?: IdentityAddress[] | null;
  textSignature?: string | null;
  htmlSignature?: string | null;
}

export interface CreateIdentityMutationRequest extends IdentityMutableFields {
  operationId: string;
  email: string;
}

export interface UpdateIdentityMutationRequest extends IdentityMutableFields {
  operationId: string;
  remoteId: string;
}

export interface DeleteIdentityMutationRequest {
  operationId: string;
  remoteId: string;
}

export interface IdentityUpsertInput {
  remoteId: string;
  name: string;
  email: string;
  replyTo: IdentityAddress[] | null;
  bcc: IdentityAddress[] | null;
  textSignature: string | null;
  htmlSignature: string | null;
  mayDelete: boolean | null;
  rawJson: string;
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
  /** EmailSubmission id holding this message for Send Later, if any. */
  scheduled_submission_remote_id: string | null;
  /** Last known undo status of that submission; null when not scheduled. */
  scheduled_undo_status: 'pending' | 'final' | 'canceled' | 'unknown' | null;
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
  charset: string | null;
}

export interface MessageBody {
  text: string;
  html: string;
  attachments: BodyAttachmentRow[];
  isComplete?: boolean;
  bodyParts?: Array<{
    kind: 'text' | 'html';
    value: string;
    isTruncated: boolean;
    blob_id: string | null;
    mime_type: string | null;
    charset: string | null;
  }>;
  truncatedParts?: Array<{
    kind: 'text' | 'html';
    blob_id: string | null;
    mime_type: string | null;
    charset?: string | null;
  }>;
}

export interface AddressbookRow {
  id: number;
  account_id: number;
  service_kind: ServiceKind;
  remote_id: string;
  name: string | null;
  description: string | null;
  sort_order: number;
  is_default: 0 | 1;
  is_subscribed: 0 | 1;
  may_write?: 0 | 1 | null;
  may_delete: 0 | 1 | null;
  ctag: string | null;
  sync_token: string | null;
  raw_json: string | null;
  is_deleted: 0 | 1;
  updated_at: number;
}

export interface AddressBookMutableFields {
  name?: string;
  description?: string | null;
  sortOrder?: number;
  isSubscribed?: boolean;
  setAsDefault?: boolean;
}

export interface CreateAddressBookMutationRequest extends AddressBookMutableFields {
  operationId: string;
  name: string;
}

export interface UpdateAddressBookMutationRequest extends AddressBookMutableFields {
  operationId: string;
  addressbookId?: number;
  remoteId?: string;
}

export interface AddressBookInventoryContact {
  remoteId: string;
  addressBookIds: string[];
  classification: 'exclusive' | 'shared';
  hasMedia: boolean;
}

export interface AddressBookInventory {
  version: 1;
  addressbookId: number | null;
  addressBookRemoteId: string;
  queryState: string | null;
  total: number;
  exclusiveCount: number;
  sharedCount: number;
  mediaBearingCount: number;
  contacts: AddressBookInventoryContact[];
}

export interface DestroyAddressBookMutationRequest {
  operationId: string;
  addressbookId?: number;
  remoteId?: string;
  confirmationInventory: AddressBookInventory;
}

export interface ContactListRow {
  id: number;
  remote_id: string | null;
  /** Durable create identity when the server exposes a valid contact uid. */
  uid?: string | null;
  /** Every address book the card is filed in; a card may be in several. */
  addressbook_ids: number[];
  display_name: string | null;
  email: string | null;
  photo?: ContactPhoto | null;
}

export interface ContactTrashListRow {
  id: number;
  uid: string;
  prior_remote_id: string;
  display_name: string;
  primary_email: string | null;
  trashed_at: number;
  expires_at: number;
  status: ContactTrashStatus;
}

export interface ContactTrashDetail extends ContactTrashListRow {
  original_addressbook_ids: string[];
  snapshot: Record<string, unknown>;
  email_keys: string[];
  media: ContactTrashMedia[];
}

export type ContactTrashLookup =
  | {
      trashId: number;
      status: 'active';
      detail: ContactTrashDetail;
    }
  | {
      trashId: number;
      status: 'inactive' | 'missing';
    }
  | {
      trashId: number;
      status: 'unreadable';
      errorType: 'invalidTrashSnapshot';
    };

export type ContactContext = 'private' | 'work';

export type ContactPhoneFeature =
  | 'fax'
  | 'main-number'
  | 'mobile'
  | 'pager'
  | 'text'
  | 'textphone'
  | 'video'
  | 'voice';

export type ContactAnniversaryKind = 'birth' | 'death' | 'wedding';

export interface ContactPartialDate {
  kind: 'partial';
  year: number | null;
  month: number | null;
  day: number | null;
}

export interface ContactTimestampDate {
  kind: 'timestamp';
  utc: string;
}

export type ContactAnniversaryDate = ContactPartialDate | ContactTimestampDate;

export interface ContactDetailResource {
  /** Stable JSContact map key. Legacy unkeyed values remain null. */
  mapKey: string | null;
  position: number;
  value: string;
  label: string | null;
  contexts: ContactContext[];
  pref: number | null;
}

export interface ContactDetailEmail extends ContactDetailResource {
  isPreferred: boolean;
}

export interface ContactDetailPhone extends ContactDetailResource {
  features: ContactPhoneFeature[];
}

export type ContactDetailLink = ContactDetailResource;

export interface ContactDetailAnniversary {
  mapKey: string | null;
  position: number;
  kind: ContactAnniversaryKind;
  date: ContactAnniversaryDate;
}

export interface ContactDetailNote {
  mapKey: string | null;
  position: number;
  value: string;
}

export interface ContactDetailOrganizationUnit {
  position: number;
  value: string;
}

export interface ContactDetailOrganization {
  mapKey: string | null;
  /**
   * Form-local identity for a new organization. Titles may reference this
   * through organizationFormId until mutation preparation mints a map key.
   */
  formId?: string | null;
  position: number;
  name: string | null;
  contexts: ContactContext[];
  units: ContactDetailOrganizationUnit[];
}

export type ContactTitleKind = 'role' | 'title';

export interface ContactDetailTitle {
  mapKey: string | null;
  position: number;
  value: string;
  kind: ContactTitleKind;
  organizationMapKey: string | null;
  /** Form-local organization identity; never serialized as a JSContact property. */
  organizationFormId?: string | null;
}

export interface ContactPhoto {
  /** Stable JSContact media map key. */
  mapKey: string;
  uri: string | null;
  blobId: string | null;
  mediaType: string | null;
  pref: number | null;
}

export interface ContactDetail {
  id: number;
  remote_id: string | null;
  addressbook_ids: number[];
  display_name: string | null;
  full_name: string | null;
  emails: ContactDetailEmail[];
  phones: ContactDetailPhone[];
  links: ContactDetailLink[];
  anniversaries: ContactDetailAnniversary[];
  notes: ContactDetailNote[];
  organizations: ContactDetailOrganization[];
  titles: ContactDetailTitle[];
  photo?: ContactPhoto | null;
}

export interface ContactMutationFields {
  fullName: string | null;
  emails: ContactDetailEmail[];
  phones: ContactDetailPhone[];
  links: ContactDetailLink[];
  anniversaries: ContactDetailAnniversary[];
  notes: ContactDetailNote[];
  organizations: ContactDetailOrganization[];
  titles: ContactDetailTitle[];
  photo?: ContactPhoto | null;
}

export interface CreateContactMutationRequest extends ContactMutationFields {
  uid: string;
  /** Local address-book ids; the sync backend resolves protocol ids. */
  addressbookIds: number[];
  /** Explicit duplication bypasses normal email-based contact enrichment. */
  allowDuplicate?: boolean;
}

export interface UpdateContactMutationRequest {
  /** Local contact id; the sync backend resolves the protocol id. */
  contactId: number;
  baseline: ContactMutationFields;
  contact: ContactMutationFields;
}

export type ContactBatchMutationRequest =
  | {
      operation: 'move';
      /** Local ids only; JMAP ids are resolved in the worker. */
      contactIds: number[];
      sourceAddressbookId: number;
      targetAddressbookId: number;
    }
  | {
      operation: 'scoped-delete';
      /** `null` identifies the All Contacts permanent-delete scope. */
      sourceAddressbookId: number | null;
      contactIds: number[];
    };

export interface ContactBatchFailure {
  contactId: number;
  errorType: string;
  message?: string;
}

export interface ContactBatchMutationResult {
  succeededContactIds: number[];
  updatedContactIds: number[];
  destroyedContactIds: number[];
  failures: ContactBatchFailure[];
}

export type ContactTrashMutationRequest =
  | {
      operation: 'restore';
      trashIds: number[];
      destinationAddressbookId?: number | null;
    }
  | {
      operation: 'delete-forever';
      trashIds: number[];
    };

export interface ContactTrashMutationResult {
  succeededTrashIds: number[];
  restoredRemoteIds: string[];
  destinationRequiredTrashIds: number[];
  failures: Array<{
    trashId: number;
    errorType: string;
    message?: string;
  }>;
}

export interface PendingMutationRow {
  id: number;
  account_id: number;
  mutation_type: MutationType;
  local_status: MutationStatus;
  target_message_id: number | null;
  request_json: string;
  optimistic_patch_json: string | null;
  /** For SEND rows this holds the durable send checkpoint. */
  server_response_json: string | null;
  error_json: string | null;
  attempts: number;
  last_attempt_at: number | null;
  not_before: number | null;
  /** Durable phase for send/draft rows; contact writes also reuse cache_pending. */
  phase: MutationPhase | null;
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
