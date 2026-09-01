/**
 * Contacts store. Backs both recipient autocomplete in compose and the
 * read-only contacts view. The store is the only path components and
 * other stores have to contact data — they never speak SQL to the
 * worker directly.
 *
 * Reads are repository-only; the store subscribes to
 * TABLE_FAMILIES.CONTACTS broadcasts so the UI re-renders when the
 * sync layer ingests a contacts delta in the background.
 */

import { defineStore } from 'pinia';
import { ref, watch } from 'vue';

import { getRepositoryAsync } from '../composables/useRepository';
import { useAuthStore } from './auth-store';
import {
  ADDRESSBOOK_ERROR,
} from '../constants/addressbook-errors';
import type { AddressBookError } from '../constants/addressbook-errors';
import {
  IDENTITY_ERROR,
  IDENTITY_ERROR_MESSAGE,
} from '../constants/identity-errors';
import type {
  IdentityActionResult,
  IdentityError,
} from '../constants/identity-errors';
import {
  MUTATION_TYPE,
  SERVICE_KIND,
} from '../constants/states';
import type { MutationType } from '../constants/states';
import { TABLE_FAMILIES } from '../db/protocol';
import type {
  AddressBookInventory,
  AddressBookMutableFields,
  AddressbookRow,
  ContactBatchFailure,
  ContactBatchMutationRequest,
  ContactBatchMutationResult,
  ContactDetail,
  ContactListRow,
  ContactMutationFields,
  ContactTrashDetail,
  ContactTrashListRow,
  ContactTrashMutationResult,
  CreateAddressBookMutationRequest,
  CreateContactMutationRequest,
  CreateIdentityMutationRequest,
  DestroyAddressBookMutationRequest,
  IdentityAddress,
  IdentityMutableFields,
  IdentityRow,
  UpdateAddressBookMutationRequest,
  UpdateContactMutationRequest,
  UpdateIdentityMutationRequest,
} from '../types';
import type { Repository } from '../db/repository';
import { addressKey } from '../utils/address-key';
import {
  contactFieldsAreEmpty,
  contactMutationFieldsFromDetail,
  legacyCreateContactFields,
  legacyUpdatedContactFields,
  validateContactFields,
  withContactDetailKeys,
} from '../utils/contact-fields';
import type { ContactFieldValidationIssue } from '../utils/contact-fields';
import {
  createContactUid,
  normalizeContactUid,
} from '../utils/contact-uid';
import { randomToken } from '../utils/random-token';
import {
  cleanIdentityAddresses,
  createIdentityOperationId,
  hasOwn,
  parseIdentityMailbox,
  pickIdentityMutableFields,
  validateIdentitySignatures,
} from '../utils/identity-fields';

interface PendingMutationInsert {
  accountId: number;
  mutationType: MutationType;
  targetMessageId: number | null;
  requestJson: string;
}

interface MutationExecution {
  ok: boolean;
  addressbook?: AddressbookRow | null;
  addressbooks?: AddressbookRow[];
  contactBatch?: ContactBatchMutationResult;
  contactTrash?: ContactTrashMutationResult;
  errorType?: string;
  ids?: string[];
  identity?: IdentityRow;
  requestMatches?: boolean;
  storedRequestJson?: string;
}

const IDENTITY_MUTATION_TYPES = new Set<MutationType>([
  MUTATION_TYPE.CREATE_IDENTITY,
  MUTATION_TYPE.UPDATE_IDENTITY,
  MUTATION_TYPE.DELETE_IDENTITY,
]);

const ADDRESSBOOK_MUTATION_TYPES = new Set<MutationType>([
  MUTATION_TYPE.CREATE_ADDRESSBOOK,
  MUTATION_TYPE.UPDATE_ADDRESSBOOK,
  MUTATION_TYPE.DESTROY_ADDRESSBOOK,
]);

const JMAP_CONTACTS_CAPABILITY = 'urn:ietf:params:jmap:contacts';
const TRUSTED_SENDERS_BOOK_NAME = 'Trusted senders';

export interface IdentityCreateInput extends IdentityMutableFields {
  operationId?: string;
  email: string;
}

export interface IdentityUpdateInput extends IdentityMutableFields {
  operationId?: string;
  remoteId: string;
}

export type IdentitySaveResult =
  | { ok: true; identity: IdentityRow }
  | { ok: false; error: IdentityError };

export type AddressBookCreateInput =
  Omit<CreateAddressBookMutationRequest, 'operationId'> & {
    operationId?: string;
  };

export interface AddressBookUpdateInput extends AddressBookMutableFields {
  addressbookId: number;
  operationId?: string;
}

export interface AddressBookDeleteInput {
  addressbookId: number;
  confirmationInventory: AddressBookInventory;
  operationId?: string;
}

export type AddressBookSaveResult =
  | { ok: true; addressbook: AddressbookRow }
  | { ok: false; error: AddressBookError };

export type AddressBookCreateResult = AddressBookSaveResult;
export type AddressBookUpdateResult = AddressBookSaveResult;

export type AddressBookInventoryResult =
  | { ok: true; inventory: AddressBookInventory }
  | { ok: false; error: AddressBookError };

export type AddressBookDeleteResult =
  | { ok: true }
  | { ok: false; error: AddressBookError };

export interface AutocompleteCandidate {
  name?: string | null;
  organization?: string | null;
  email: string;
  source: 'contact';
  is_preferred?: 0 | 1;
  /** Ranking evidence derived from the latest bounded Sent window. */
  send_count?: number;
  last_sent_at?: number | null;
}

/**
 * Pragmatic email shape check used to gate the contact form. The server
 * is the real authority; this just stops obviously-invalid input from
 * being queued.
 */
function isValidEmail(value: string): boolean {
  return /^\S+@\S+\.\S+$/.test(value.trim());
}

/**
 * Trim/de-duplicate an email list and validate each non-empty entry.
 * Returns { ok:false } when any non-empty entry is malformed.
 */
function cleanEmailList(emails: string[]): { ok: boolean; list: string[] } {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const raw of emails ?? []) {
    const addr = String(raw ?? '').trim();
    if (!addr) continue;
    if (!isValidEmail(addr)) return { ok: false, list: [] };
    const key = addressKey(addr);
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(addr);
  }
  return { ok: true, list };
}

function preparedIdentityFields(
  input: Record<string, unknown>,
): { error: IdentityError | null; fields: IdentityMutableFields } {
  if (
    hasOwn(input, 'name')
    && (typeof input.name !== 'string' || /[\r\n]/.test(input.name))
  ) {
    return { error: IDENTITY_ERROR.INVALID_NAME, fields: {} };
  }
  const fields = pickIdentityMutableFields(input);
  for (const [property, error] of [
    ['replyTo', IDENTITY_ERROR.INVALID_REPLY_TO],
    ['bcc', IDENTITY_ERROR.INVALID_BCC],
  ] as const) {
    if (!hasOwn(input, property)) continue;
    const addresses = cleanIdentityAddresses(input[property] as IdentityAddress[] | null);
    if (addresses === undefined) return { error, fields: {} };
    Object.assign(fields, { [property]: addresses });
  }
  const signatureIssue = validateIdentitySignatures(
    hasOwn(input, 'htmlSignature') ? input.htmlSignature : undefined,
    hasOwn(input, 'textSignature') ? input.textSignature : undefined,
  );
  if (signatureIssue === 'too-large') {
    return { error: IDENTITY_ERROR.SIGNATURE_TOO_LARGE, fields: {} };
  }
  if (signatureIssue === 'invalid') {
    return { error: IDENTITY_ERROR.INVALID_SIGNATURE, fields: {} };
  }
  return { error: null, fields };
}

export type ContactCreateInput =
  | {
      contact: ContactMutationFields;
      addressbookIds?: number[];
      allowDuplicate?: boolean;
    }
  | {
      name?: string | null;
      emails: string[];
      addressbookId?: number | null;
    };

export type ContactUpdateInput =
  | {
      contactId: number;
      baseline: ContactMutationFields;
      contact: ContactMutationFields;
    }
  | {
      remoteId: string | null;
      name?: string | null;
      emails: string[];
    };

export type ContactCreateResult =
  | {
      ok: true;
      uid: string;
      contactId: number;
      detail: ContactDetail;
    }
  | { ok: false };

export type ContactBatchActionResult = ContactBatchMutationResult & {
  ok: boolean;
};

export type ContactTrashActionResult = ContactTrashMutationResult & {
  ok: boolean;
};

export const CONTACT_MISSING_MESSAGE =
  'This contact no longer exists. Discard these changes or create a new contact.';

interface ContactCreateExecution {
  ok: boolean;
  uid: string | null;
  contactId: number | null;
  detail: ContactDetail | null;
}

function failedContactCreate(): ContactCreateExecution {
  return {
    ok: false,
    uid: null,
    contactId: null,
    detail: null,
  };
}

function invalidContactFields(
  fields: ContactMutationFields,
  baseline: ContactMutationFields | null = null,
): string | null {
  const issue = validateContactFields(fields, {
    baseline,
    rejectEmpty: true,
    validateEmails: true,
  });
  if (!issue) return null;
  return contactValidationMessage(issue);
}

function contactValidationMessage(issue: ContactFieldValidationIssue): string {
  switch (issue) {
    case 'invalid-email':
    case 'empty-email':
      return 'Enter a valid email address.';
    case 'empty-phone':
      return 'Enter a phone number.';
    case 'invalid-anniversary':
      return 'Enter a valid contact date.';
    case 'invalid-note':
      return 'Enter a valid note.';
    case 'invalid-organization-reference':
      return 'Choose a valid organization for each title.';
    case 'invalid-photo':
      return 'Choose a PNG, JPEG, GIF, or WebP image no larger than 1 MiB.';
    case 'empty-organization':
      return 'Enter an organization or department.';
    case 'invalid-title':
      return 'Enter a valid title or role.';
    case 'invalid-website':
    case 'empty-website':
      return 'Enter an absolute HTTP or HTTPS website.';
    case 'empty-contact':
      return 'Enter at least one contact detail.';
    case 'duplicate-map-key':
    case 'invalid-collection':
    case 'invalid-fields':
    case 'invalid-map-key':
      return 'Enter valid contact details.';
    default: {
      const exhaustive: never = issue;
      return exhaustive;
    }
  }
}

function uniqueContactIds(values: readonly number[]): number[] {
  return [...new Set(values.filter((id) => Number.isSafeInteger(id) && id > 0))];
}

function contactBatchResult(value: unknown): ContactBatchMutationResult | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<ContactBatchMutationResult>;
  if (
    !Array.isArray(candidate.succeededContactIds)
    || !Array.isArray(candidate.updatedContactIds)
    || !Array.isArray(candidate.destroyedContactIds)
    || !Array.isArray(candidate.failures)
  ) {
    return null;
  }
  return {
    succeededContactIds: uniqueContactIds(candidate.succeededContactIds),
    updatedContactIds: uniqueContactIds(candidate.updatedContactIds),
    destroyedContactIds: uniqueContactIds(candidate.destroyedContactIds),
    failures: candidate.failures.flatMap((failure): ContactBatchFailure[] => {
      if (
        !failure
        || !Number.isSafeInteger(failure.contactId)
        || failure.contactId <= 0
        || typeof failure.errorType !== 'string'
      ) {
        return [];
      }
      return [{
        contactId: failure.contactId,
        errorType: failure.errorType,
        ...(typeof failure.message === 'string' ? { message: failure.message } : {}),
      }];
    }),
  };
}

function failedContactBatch(
  contactIds: readonly number[],
  errorType: string,
  message: string,
): ContactBatchActionResult {
  return {
    ok: false,
    succeededContactIds: [],
    updatedContactIds: [],
    destroyedContactIds: [],
    failures: uniqueContactIds(contactIds).map((contactId) => ({
      contactId,
      errorType,
      message,
    })),
  };
}

function contactTrashResult(value: unknown): ContactTrashMutationResult | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<ContactTrashMutationResult>;
  if (
    !Array.isArray(candidate.succeededTrashIds)
    || !Array.isArray(candidate.restoredRemoteIds)
    || !Array.isArray(candidate.destinationRequiredTrashIds)
    || !Array.isArray(candidate.failures)
  ) {
    return null;
  }
  return {
    succeededTrashIds: uniqueContactIds(candidate.succeededTrashIds),
    restoredRemoteIds: candidate.restoredRemoteIds.filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    ),
    destinationRequiredTrashIds: uniqueContactIds(
      candidate.destinationRequiredTrashIds,
    ),
    failures: candidate.failures.flatMap((failure) =>
      failure
      && Number.isSafeInteger(failure.trashId)
      && failure.trashId > 0
      && typeof failure.errorType === 'string'
        ? [{
            trashId: failure.trashId,
            errorType: failure.errorType,
            ...(typeof failure.message === 'string' ? { message: failure.message } : {}),
          }]
        : []),
  };
}

function failedContactTrash(
  trashIds: readonly number[],
  errorType: string,
  message: string,
): ContactTrashActionResult {
  return {
    ok: false,
    succeededTrashIds: [],
    restoredRemoteIds: [],
    destinationRequiredTrashIds: [],
    failures: uniqueContactIds(trashIds).map((trashId) => ({
      trashId,
      errorType,
      message,
    })),
  };
}

const ADDRESSBOOK_ERROR_MESSAGE: Record<AddressBookError, string> = {
  [ADDRESSBOOK_ERROR.INVALID_NAME]:
    'Enter an address book name without a line break.',
  [ADDRESSBOOK_ERROR.PERMISSION_DENIED]:
    'You don’t have permission to manage this address book.',
  [ADDRESSBOOK_ERROR.UNSUPPORTED_SUBSCRIPTION]:
    'The server does not allow this subscription change.',
  [ADDRESSBOOK_ERROR.STATE_MISMATCH]:
    'The address book changed on the server. Refresh and try again.',
  [ADDRESSBOOK_ERROR.MISSING]:
    'This address book no longer exists.',
  [ADDRESSBOOK_ERROR.SERVER_UNAVAILABLE]:
    'The address book service is temporarily unavailable.',
  [ADDRESSBOOK_ERROR.CACHE_REPAIR_FAILED]:
    'The address book changed on the server, but the local list could not be refreshed.',
  [ADDRESSBOOK_ERROR.AMBIGUOUS_CREATE]:
    'The server may have created this address book, but it could not be identified safely.',
  [ADDRESSBOOK_ERROR.CONFIRMATION_REQUIRED]:
    'Review the address book contents before deleting it.',
  [ADDRESSBOOK_ERROR.CONFIRMATION_STALE]:
    'The address book contents changed. Review them again before deleting.',
  [ADDRESSBOOK_ERROR.PROTECTED]:
    'Trusted Senders cannot be deleted.',
  [ADDRESSBOOK_ERROR.LAST_ADDRESSBOOK]:
    'The last address book cannot be deleted.',
  [ADDRESSBOOK_ERROR.INVALID_ARGUMENTS]:
    'Enter valid address book details.',
};

const ADDRESSBOOK_ERROR_TYPES = new Set<string>(
  Object.values(ADDRESSBOOK_ERROR),
);

function canonicalAddressBookText(value: string): string {
  return value.normalize('NFC').replace(/\r\n?/gu, '\n');
}

function canonicalAddressBookName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (/[\r\n]/u.test(value)) return null;
  const name = canonicalAddressBookText(value).trim();
  return name || null;
}

function validAddressBookMetadata(input: Record<string, unknown>): boolean {
  return (
    (!hasOwn(input, 'description')
      || input.description === null
      || typeof input.description === 'string')
    && (!hasOwn(input, 'sortOrder')
      || (
        Number.isSafeInteger(input.sortOrder)
        && Number(input.sortOrder) >= 0
      ))
    && (!hasOwn(input, 'isSubscribed')
      || typeof input.isSubscribed === 'boolean')
    && (!hasOwn(input, 'setAsDefault')
      || typeof input.setAsDefault === 'boolean')
  );
}

function createAddressBookOperationId(): string {
  return `addressbook-${randomToken()}`;
}

function isTrustedSendersBook(book: AddressbookRow): boolean {
  return canonicalAddressBookName(book.name)?.toLocaleLowerCase()
    === TRUSTED_SENDERS_BOOK_NAME.toLocaleLowerCase();
}

export const useContactsStore = defineStore('contacts', () => {
  const authStore = useAuthStore();
  const addressbooks = ref<AddressbookRow[]>([]);
  const canCreateAddressBook = ref(false);
  const contacts = ref<ContactListRow[]>([]);
  const trash = ref<ContactTrashListRow[]>([]);
  const identities = ref<IdentityRow[]>([]);
  const error = ref<string | null>(null);
  const saving = ref(false);
  const deletingIds = ref<number[]>([]);
  const movingIds = ref<number[]>([]);
  const restoringTrashIds = ref<number[]>([]);
  const deletingTrashIds = ref<number[]>([]);
  const deletingIdentityIds = ref<number[]>([]);
  const deletingAddressBookIds = ref<number[]>([]);
  const identityOperationIds = new Map<string, string>();
  const addressBookOperationIds = new Map<string, string>();
  const addressBookOperations = new Map<string, Promise<unknown>>();
  let repo: Repository | null = null;
  let unsubscribe: (() => void) | null = null;
  let stopAccountWatch: (() => void) | null = null;

  async function attach(): Promise<void> {
    if (repo) return;
    repo = await getRepositoryAsync();
    unsubscribe = repo.subscribe(onTablesTouched);
    stopAccountWatch = watch(
      () => authStore.accountId,
      async (newId) => {
        if (newId) {
          await refresh();
          return;
        }
        $reset();
      },
    );
    if (authStore.accountId != null) {
      await refresh();
    } else {
      $reset();
    }
  }

  function detach(): void {
    unsubscribe?.();
    unsubscribe = null;
    stopAccountWatch?.();
    stopAccountWatch = null;
    repo = null;
    $reset();
  }

  /**
   * Drop every piece of session-scoped state. Mirrors the reset
   * shape used by mail-store and compose-store so a logout or
   * account switch leaves the store empty rather than holding
   * onto rows from the previous account.
   */
  function $reset(): void {
    addressbooks.value = [];
    canCreateAddressBook.value = false;
    contacts.value = [];
    trash.value = [];
    identities.value = [];
    error.value = null;
    saving.value = false;
    deletingIds.value = [];
    movingIds.value = [];
    restoringTrashIds.value = [];
    deletingTrashIds.value = [];
    deletingIdentityIds.value = [];
    deletingAddressBookIds.value = [];
    identityOperationIds.clear();
    addressBookOperationIds.clear();
    addressBookOperations.clear();
  }

  function onTablesTouched(tables: string[]): void {
    if (authStore.accountId == null) return;
    if (tables.includes(TABLE_FAMILIES.ACCOUNTS)) {
      refreshAddressBookCapability().catch((err) => {
        console.warn('[contacts-store] capability refresh after broadcast failed', err);
      });
    }
    if (tables.includes(TABLE_FAMILIES.CONTACTS)) {
      Promise.all([refreshAddressbooks(), refreshContacts()]).catch((err) => {
        console.warn('[contacts-store] contact refresh after broadcast failed', err);
      });
    }
    if (tables.includes(TABLE_FAMILIES.CONTACTS_TRASH)) {
      refreshTrash().catch((err) => {
        console.warn('[contacts-store] trash refresh after broadcast failed', err);
      });
    }
    if (tables.includes(TABLE_FAMILIES.IDENTITIES)) {
      refreshIdentities().catch((err) => {
        console.warn('[contacts-store] identity refresh after broadcast failed', err);
      });
    }
  }

  async function refresh(): Promise<void> {
    await Promise.all([
      refreshAddressBookCapability(),
      refreshAddressbooks(),
      refreshContacts(),
      refreshTrash(),
      refreshIdentities(),
    ]);
  }

  async function refreshAddressBookCapability(): Promise<void> {
    canCreateAddressBook.value = false;
    if (!repo || authStore.accountId == null) return;
    const accountId = authStore.accountId;
    try {
      const capabilities = await repo.getAccountCapabilities(
        accountId,
        SERVICE_KIND.JMAP_CONTACTS,
      );
      if (authStore.accountId !== accountId) return;
      const contactsCapability = capabilities?.[JMAP_CONTACTS_CAPABILITY];
      canCreateAddressBook.value = Boolean(
        contactsCapability
        && typeof contactsCapability === 'object'
        && (contactsCapability as { mayCreateAddressBook?: unknown })
          .mayCreateAddressBook === true,
      );
    } catch {
      canCreateAddressBook.value = false;
    }
  }

  async function refreshAddressbooks(): Promise<void> {
    if (!repo || authStore.accountId == null) {
      addressbooks.value = [];
      return;
    }
    try {
      addressbooks.value = await repo.listAddressbooks(authStore.accountId);
    } catch (err: any) {
      error.value = err?.message ?? String(err);
    }
  }

  async function refreshContacts(options: { limit?: number } = {}): Promise<void> {
    if (!repo || authStore.accountId == null) {
      contacts.value = [];
      return;
    }
    try {
      contacts.value = await repo.listContacts(authStore.accountId, options);
    } catch (err: any) {
      error.value = err?.message ?? String(err);
    }
  }

  async function refreshTrash(): Promise<void> {
    if (!repo || authStore.accountId == null) {
      trash.value = [];
      return;
    }
    try {
      trash.value = await repo.listContactTrash(authStore.accountId);
    } catch (err: any) {
      error.value = err?.message ?? String(err);
    }
  }

  async function refreshIdentities(): Promise<void> {
    if (!repo || authStore.accountId == null) {
      identities.value = [];
      return;
    }
    try {
      identities.value = await repo.listIdentities(authStore.accountId);
    } catch (err: any) {
      error.value = err?.message ?? String(err);
    }
  }

  /**
   * Read-through accessor so callers that just want the current list
   * can `await store.listContacts()` without depending on the watch
   * having already fired. Returns the same array bound to `contacts`.
   */
  async function listContacts(options: { limit?: number } = {}): Promise<ContactListRow[]> {
    await refreshContacts(options);
    return contacts.value;
  }

  async function listIdentities(
    options: { refreshServer?: boolean } = {},
  ): Promise<IdentityRow[]> {
    await refreshIdentities();
    if (options.refreshServer && repo && authStore.accountId != null) {
      try {
        await repo.ensureIdentities(authStore.accountId);
        await refreshIdentities();
      } catch (err: any) {
        error.value = err?.message ?? String(err);
      }
    }
    return identities.value;
  }

  /**
   * Resolve a typeahead prefix into ContactCard candidates.
   *
   * `exclude` carries the addresses already in To, Cc and Bcc. They are
   * dropped as candidates are gathered — before ranking, and before the count
   * that decides whether the expensive tier is worth running — rather than
   * filtered out of the finished list. A recipient already entered must not
   * spend one of the limited places, nor make the list look full (CS-3.7).
   */
  async function autocomplete(
    prefix: string, limit = 20, exclude: string[] = [],
  ): Promise<AutocompleteCandidate[]> {
    if (!repo || authStore.accountId == null || !prefix) {
      return [];
    }
    return repo.autocompleteContacts(authStore.accountId, prefix, limit, exclude);
  }

  /**
   * Insert a pending mutation and run it, returning whether it actually
   * applied. Mirrors mail-store's runChunkedMutation success criteria:
   * a run that attempted nothing (e.g. the row never reached a runnable
   * state) is treated as a failure, not a silent success — except for
   * the already-succeeded race where runMutation reports
   * `attempted: 0, succeeded: 1`.
   */
  async function queueAndRunResult(
    mutation: PendingMutationInsert,
  ): Promise<MutationExecution> {
    if (!repo || authStore.accountId == null) return { ok: false };
    let operationId: string | null = null;
    const identityMutation = IDENTITY_MUTATION_TYPES.has(mutation.mutationType);
    const addressBookMutation = ADDRESSBOOK_MUTATION_TYPES.has(
      mutation.mutationType,
    );
    if (identityMutation || addressBookMutation) {
      try {
        const request = JSON.parse(mutation.requestJson);
        operationId = typeof request?.operationId === 'string' ? request.operationId : null;
      } catch {
        operationId = null;
      }
    }
    const inserted = operationId && identityMutation
      ? await repo.ensureIdentityMutation({ ...mutation, operationId })
      : operationId && addressBookMutation
        ? await repo.ensureAddressbookMutation({ ...mutation, operationId })
        : await repo.insertPendingMutation(mutation);
    if (inserted?.errorType) {
      return {
        ok: false,
        errorType: inserted.errorType,
        requestMatches: inserted.requestMatches,
        storedRequestJson: inserted.storedRequestJson,
      };
    }
    const result = typeof repo.runMutation === 'function' && inserted?.id != null
      ? await repo.runMutation(authStore.accountId, inserted.id)
      : await repo.drainOutbox(authStore.accountId);
    const batch = contactBatchResult(result?.result);
    const trashMutation = contactTrashResult(result?.result);
    return {
      ok: (result?.failed ?? 0) === 0
        && ((result?.attempted ?? 0) > 0 || (result?.succeeded ?? 0) > 0),
      ...(batch ? { contactBatch: batch } : {}),
      ...(trashMutation ? { contactTrash: trashMutation } : {}),
      ...(Array.isArray(result?.result?.addressbooks)
        ? { addressbooks: result.result.addressbooks as AddressbookRow[] }
        : {}),
      ...(result?.result && Object.hasOwn(result.result, 'addressbook')
        ? { addressbook: result.result.addressbook as AddressbookRow | null }
        : {}),
      ...(typeof result?.errorType === 'string' ? { errorType: result.errorType } : {}),
      ...(Array.isArray(result?.result?.ids)
        ? {
            ids: result.result.ids.filter(
              (id: unknown): id is string => typeof id === 'string',
            ),
          }
        : {}),
      ...(result?.result?.identity ? { identity: result.result.identity as IdentityRow } : {}),
      ...(typeof inserted?.requestMatches === 'boolean'
        ? { requestMatches: inserted.requestMatches }
        : {}),
      ...(typeof inserted?.storedRequestJson === 'string'
        ? { storedRequestJson: inserted.storedRequestJson }
        : {}),
    };
  }

  /**
   * Load a single contact plus its full email list for the edit form.
   */
  async function getContact(contactId: number): Promise<ContactDetail | null> {
    if (!repo || authStore.accountId == null) return null;
    return repo.getContact(authStore.accountId, contactId);
  }

  async function getContactTrash(trashId: number): Promise<ContactTrashDetail | null> {
    if (!repo || authStore.accountId == null) return null;
    return repo.getContactTrash(authStore.accountId, trashId);
  }

  /**
   * Add a contact. When `addressbookId` names a locally-known book the
   * card is filed there (the selected folder); otherwise it lands in
   * the account's default book. `emails` is an ordered list (first is
   * primary). Queues a createContact mutation and runs it; the outbox
   * handler creates the ContactCard server-side and reconciles the
   * local cache, so the new row arrives via the CONTACTS broadcast.
   * Returns true on success.
   */
  async function executeContactCreate(
    input: ContactCreateInput,
  ): Promise<ContactCreateExecution> {
    error.value = null;
    if (!repo || authStore.accountId == null) {
      error.value = 'Not connected.';
      return failedContactCreate();
    }
    let fields: ContactMutationFields;
    let selectedAddressbookIds: number[];
    if ('contact' in input) {
      fields = withContactDetailKeys(input.contact, null);
      selectedAddressbookIds = input.addressbookIds ?? [];
    } else {
      const name = input.name?.trim() || null;
      const { ok, list } = cleanEmailList(input.emails);
      if (!ok) {
        error.value = 'Enter a valid email address.';
        return failedContactCreate();
      }
      fields = legacyCreateContactFields(name, list);
      selectedAddressbookIds = input.addressbookId == null ? [] : [input.addressbookId];
    }
    const invalid = invalidContactFields(fields);
    if (invalid) {
      error.value = invalid;
      return failedContactCreate();
    }
    if (contactFieldsAreEmpty(fields)) {
      error.value = 'Enter at least one contact detail.';
      return failedContactCreate();
    }
    const uid = createContactUid();
    const request: CreateContactMutationRequest = {
      ...fields,
      uid,
      addressbookIds: selectedAddressbookIds,
      allowDuplicate: 'contact' in input && input.allowDuplicate === true,
    };
    saving.value = true;
    try {
      const mutation = await queueAndRunResult({
        accountId: authStore.accountId,
        mutationType: MUTATION_TYPE.CREATE_CONTACT,
        targetMessageId: null,
        requestJson: JSON.stringify(request),
      });
      if (!mutation.ok) {
        error.value = 'Could not add the contact. Please try again.';
        return failedContactCreate();
      }
      await refreshContacts();
      const normalizedUid = normalizeContactUid(uid);
      const remoteIds = new Set(mutation.ids ?? []);
      const created = contacts.value.find((contact) =>
        contact.remote_id != null && remoteIds.has(contact.remote_id))
        ?? contacts.value.find((contact) =>
          normalizeContactUid(contact.uid) === normalizedUid)
        ?? null;
      const detail = created == null
        ? null
        : await repo.getContact(authStore.accountId, created.id);
      return {
        ok: true,
        uid,
        contactId: created?.id ?? null,
        detail,
      };
    } catch (err: any) {
      error.value = err?.message ?? String(err);
      return failedContactCreate();
    } finally {
      saving.value = false;
    }
  }

  async function createContact(input: ContactCreateInput): Promise<boolean> {
    return (await executeContactCreate(input)).ok;
  }

  async function createContactResult(
    input: ContactCreateInput,
  ): Promise<ContactCreateResult> {
    const result = await executeContactCreate(input);
    if (
      !result.ok
      || result.uid == null
      || result.contactId == null
      || result.detail == null
    ) {
      if (result.ok) {
        error.value = 'The contact was saved, but its cached detail is unavailable.';
      }
      return { ok: false };
    }
    return {
      ok: true,
      uid: result.uid,
      contactId: result.contactId,
      detail: result.detail,
    };
  }

  /**
   * Edit an existing contact's name and email list. `emails` is the full
   * desired ordered list; the outbox handler merges it against the
   * server card so untouched email metadata and other card fields are
   * preserved. Returns true on success.
   */
  async function updateContact(
    input: ContactUpdateInput,
  ): Promise<boolean> {
    error.value = null;
    if (!repo || authStore.accountId == null) {
      error.value = 'Not connected.';
      return false;
    }
    const contactId = 'contactId' in input
      ? input.contactId
      : contacts.value.find((contact) => contact.remote_id === input.remoteId)?.id;
    if (contactId == null) {
      error.value = 'This contact cannot be edited yet — try again in a moment.';
      return false;
    }
    const detail = await repo.getContact(authStore.accountId, contactId);
    if (!detail) {
      error.value = CONTACT_MISSING_MESSAGE;
      return false;
    }
    let baseline: ContactMutationFields;
    let next: ContactMutationFields;
    if ('contact' in input) {
      baseline = input.baseline;
      next = withContactDetailKeys(input.contact, baseline);
    } else {
      baseline = contactMutationFieldsFromDetail(detail);
      const { ok, list } = cleanEmailList(input.emails);
      if (!ok) {
        error.value = 'Enter a valid email address.';
        return false;
      }
      next = legacyUpdatedContactFields(baseline, input.name?.trim() || null, list);
    }
    const invalid = invalidContactFields(next, baseline);
    if (invalid) {
      error.value = invalid;
      return false;
    }
    const request: UpdateContactMutationRequest = {
      contactId,
      baseline,
      contact: next,
    };
    saving.value = true;
    try {
      const mutation = await queueAndRunResult({
        accountId: authStore.accountId,
        mutationType: MUTATION_TYPE.UPDATE_CONTACT,
        targetMessageId: null,
        requestJson: JSON.stringify(request),
      });
      if (!mutation.ok) {
        error.value = mutation.errorType === 'notFound'
          ? CONTACT_MISSING_MESSAGE
          : 'Could not save the contact. Please try again.';
        return false;
      }
      await refreshContacts();
      return true;
    } catch (err: any) {
      error.value = err?.message ?? String(err);
      return false;
    } finally {
      saving.value = false;
    }
  }

  function writableContactBook(id: number): AddressbookRow | null {
    return addressbooks.value.find((book) =>
      book.id === id
      && book.account_id === authStore.accountId
      && book.service_kind === SERVICE_KIND.JMAP_CONTACTS
      && book.is_deleted === 0
      && book.may_write === 1) ?? null;
  }

  function contactBatchValidationError(
    request: ContactBatchMutationRequest,
  ): string | null {
    if (request.contactIds.length === 0) return 'Select at least one contact.';
    const selected = request.contactIds.map((id) =>
      contacts.value.find((contact) => contact.id === id) ?? null);
    if (selected.some((contact) => !contact?.remote_id)) {
      return 'One or more contacts are not available for this action.';
    }

    switch (request.operation) {
      case 'move': {
        if (
          request.sourceAddressbookId === request.targetAddressbookId
          || !writableContactBook(request.sourceAddressbookId)
          || !writableContactBook(request.targetAddressbookId)
        ) {
          return 'Choose a different writable address book.';
        }
        if (selected.some((contact) =>
          !contact!.addressbook_ids.includes(request.sourceAddressbookId))) {
          return 'One or more contacts are no longer in this address book.';
        }
        return null;
      }
      case 'scoped-delete': {
        if (request.sourceAddressbookId != null) {
          if (!writableContactBook(request.sourceAddressbookId)) {
            return 'This address book is read-only.';
          }
          if (selected.some((contact) =>
            !contact!.addressbook_ids.includes(request.sourceAddressbookId!))) {
            return 'One or more contacts are no longer in this address book.';
          }
          return null;
        }
        const knownWritableIds = new Set(
          addressbooks.value
            .filter((book) => writableContactBook(book.id))
            .map((book) => book.id),
        );
        if (selected.some((contact) =>
          contact!.addressbook_ids.length === 0
          || contact!.addressbook_ids.some((id) => !knownWritableIds.has(id)))) {
          return 'One or more contacts are in a read-only address book.';
        }
        return null;
      }
      default: {
        const exhaustive: never = request;
        return exhaustive;
      }
    }
  }

  function optimisticallyApplyContactBatch(request: ContactBatchMutationRequest): void {
    const selected = new Set(request.contactIds);
    switch (request.operation) {
      case 'move':
        contacts.value = contacts.value.map((contact) => {
          if (!selected.has(contact.id)) return contact;
          return {
            ...contact,
            addressbook_ids: [
              ...contact.addressbook_ids.filter(
                (id) => id !== request.sourceAddressbookId,
              ),
              ...(
                contact.addressbook_ids.includes(request.targetAddressbookId)
                  ? []
                  : [request.targetAddressbookId]
              ),
            ],
          };
        });
        return;
      case 'scoped-delete':
        contacts.value = contacts.value.flatMap((contact): ContactListRow[] => {
          if (!selected.has(contact.id)) return [contact];
          if (request.sourceAddressbookId == null) return [];
          const memberships = contact.addressbook_ids.filter(
            (id) => id !== request.sourceAddressbookId,
          );
          return memberships.length > 0
            ? [{ ...contact, addressbook_ids: memberships }]
            : [];
        });
        return;
      default: {
        const exhaustive: never = request;
        return exhaustive;
      }
    }
  }

  async function mutateContacts(
    input: ContactBatchMutationRequest,
  ): Promise<ContactBatchActionResult> {
    error.value = null;
    const contactIds = uniqueContactIds(input.contactIds);
    const request: ContactBatchMutationRequest = input.operation === 'move'
      ? { ...input, contactIds }
      : { ...input, contactIds };
    if (!repo || authStore.accountId == null) {
      error.value = 'Not connected.';
      return failedContactBatch(contactIds, 'notConnected', error.value);
    }
    const validationError = contactBatchValidationError(request);
    if (validationError) {
      error.value = validationError;
      return failedContactBatch(contactIds, 'permissionDenied', validationError);
    }

    const moving = request.operation === 'move';
    if (moving) movingIds.value = [...new Set([...movingIds.value, ...contactIds])];
    else deletingIds.value = [...new Set([...deletingIds.value, ...contactIds])];
    saving.value = true;
    optimisticallyApplyContactBatch(request);
    try {
      const mutation = await queueAndRunResult({
        accountId: authStore.accountId,
        mutationType: MUTATION_TYPE.CONTACT_BATCH,
        targetMessageId: null,
        requestJson: JSON.stringify(request),
      });
      await refreshContacts();
      const result = mutation.contactBatch;
      if (!result) {
        const message = moving
          ? 'Could not move the selected contacts. Please try again.'
          : 'Could not delete the selected contacts. Please try again.';
        error.value = message;
        return failedContactBatch(contactIds, mutation.errorType ?? 'unknown', message);
      }
      const settledIds = new Set([
        ...result.succeededContactIds,
        ...result.failures.map((failure) => failure.contactId),
      ]);
      const unresolved = contactIds
        .filter((contactId) => !settledIds.has(contactId))
        .map((contactId): ContactBatchFailure => ({
          contactId,
          errorType: mutation.errorType ?? 'unknown',
        }));
      const complete = {
        ...result,
        failures: [...result.failures, ...unresolved],
      };
      if (complete.failures.length > 0) {
        const succeeded = complete.succeededContactIds.length;
        const failed = complete.failures.length;
        error.value = succeeded > 0
          ? `${succeeded} contact${succeeded === 1 ? '' : 's'} updated; ${failed} could not be updated.`
          : `Could not update ${failed === 1 ? 'the contact' : 'the selected contacts'}.`;
      }
      return {
        ...complete,
        ok: mutation.ok && complete.failures.length === 0,
      };
    } catch (err: any) {
      error.value = err?.message ?? String(err);
      await refreshContacts();
      return failedContactBatch(contactIds, 'transport', error.value);
    } finally {
      const completed = new Set(contactIds);
      movingIds.value = movingIds.value.filter((id) => !completed.has(id));
      deletingIds.value = deletingIds.value.filter((id) => !completed.has(id));
      saving.value = false;
    }
  }

  function deleteContacts(
    contactIds: number[],
    sourceAddressbookId: number | null,
  ): Promise<ContactBatchActionResult> {
    return mutateContacts({
      operation: 'scoped-delete',
      contactIds,
      sourceAddressbookId,
    });
  }

  function moveContacts(
    contactIds: number[],
    sourceAddressbookId: number,
    targetAddressbookId: number,
  ): Promise<ContactBatchActionResult> {
    return mutateContacts({
      operation: 'move',
      contactIds,
      sourceAddressbookId,
      targetAddressbookId,
    });
  }

  async function deleteContact(contact: ContactListRow): Promise<boolean> {
    return (await deleteContacts([contact.id], null)).ok;
  }

  async function mutateContactTrash(
    operation: 'delete-forever' | 'restore',
    trashIdsInput: number[],
    destinationAddressbookId: number | null = null,
  ): Promise<ContactTrashActionResult> {
    const trashIds = uniqueContactIds(trashIdsInput);
    error.value = null;
    if (!repo || authStore.accountId == null) {
      error.value = 'Not connected.';
      return failedContactTrash(trashIds, 'notConnected', error.value);
    }
    if (
      operation === 'restore'
      && destinationAddressbookId != null
      && !writableContactBook(destinationAddressbookId)
    ) {
      error.value = 'Choose a writable address book.';
      return failedContactTrash(trashIds, 'permissionDenied', error.value);
    }
    const pending = operation === 'restore' ? restoringTrashIds : deletingTrashIds;
    pending.value = [...new Set([...pending.value, ...trashIds])];
    saving.value = true;
    try {
      const mutation = await queueAndRunResult({
        accountId: authStore.accountId,
        mutationType: MUTATION_TYPE.CONTACT_TRASH,
        targetMessageId: null,
        requestJson: JSON.stringify({
          operation,
          trashIds,
          ...(operation === 'restore' && destinationAddressbookId != null
            ? { destinationAddressbookId }
            : {}),
        }),
      });
      await Promise.all([refreshTrash(), refreshContacts()]);
      if (!mutation.contactTrash) {
        const message = operation === 'restore'
          ? 'Could not restore the selected contacts. Please try again.'
          : 'Could not delete the selected contacts forever. Please try again.';
        error.value = message;
        return failedContactTrash(trashIds, mutation.errorType ?? 'unknown', message);
      }
      const complete = mutation.contactTrash;
      if (complete.failures.length > 0) {
        error.value = `${complete.failures.length} contact${
          complete.failures.length === 1 ? '' : 's'
        } could not be updated.`;
      }
      return {
        ...complete,
        ok: mutation.ok
          && complete.failures.length === 0
          && complete.destinationRequiredTrashIds.length === 0,
      };
    } catch (err: any) {
      error.value = err?.message ?? String(err);
      await Promise.all([refreshTrash(), refreshContacts()]);
      return failedContactTrash(trashIds, 'transport', error.value);
    } finally {
      const completed = new Set(trashIds);
      pending.value = pending.value.filter((id) => !completed.has(id));
      saving.value = false;
    }
  }

  function restoreContactTrash(
    trashIds: number[],
    destinationAddressbookId: number | null = null,
  ): Promise<ContactTrashActionResult> {
    return mutateContactTrash('restore', trashIds, destinationAddressbookId);
  }

  function deleteContactTrashForever(
    trashIds: number[],
  ): Promise<ContactTrashActionResult> {
    return mutateContactTrash('delete-forever', trashIds);
  }

  function addressBookErrorForMutation(errorType?: string): AddressBookError {
    if (errorType && ADDRESSBOOK_ERROR_TYPES.has(errorType)) {
      return errorType as AddressBookError;
    }
    switch (errorType) {
      case 'accountNotFound':
      case 'accountNotSupportedByMethod':
      case 'accountReadOnly':
      case 'authorizationFailed':
      case 'forbidden':
        return ADDRESSBOOK_ERROR.PERMISSION_DENIED;
      case 'invalidName':
        return ADDRESSBOOK_ERROR.INVALID_NAME;
      case 'invalidArguments':
      case 'invalidProperties':
        return ADDRESSBOOK_ERROR.INVALID_ARGUMENTS;
      case 'notFound':
        return ADDRESSBOOK_ERROR.MISSING;
      case 'stateMismatch':
        return ADDRESSBOOK_ERROR.STATE_MISMATCH;
      default:
        return ADDRESSBOOK_ERROR.SERVER_UNAVAILABLE;
    }
  }

  function addressBookFailure(
    code: AddressBookError,
  ): { ok: false; error: AddressBookError } {
    error.value = ADDRESSBOOK_ERROR_MESSAGE[code];
    return { ok: false, error: code };
  }

  function operationIdForAddressBook(
    key: string,
    supplied: string | undefined,
  ): string {
    const existing = addressBookOperationIds.get(key);
    if (existing) return existing;
    const operationId = supplied ?? createAddressBookOperationId();
    addressBookOperationIds.set(key, operationId);
    return operationId;
  }

  function finishAddressBookOperation(
    key: string,
    operationId: string,
    errorCode: AddressBookError | null,
  ): void {
    if (
      errorCode !== ADDRESSBOOK_ERROR.AMBIGUOUS_CREATE
      && errorCode !== ADDRESSBOOK_ERROR.CACHE_REPAIR_FAILED
      && errorCode !== ADDRESSBOOK_ERROR.SERVER_UNAVAILABLE
      && addressBookOperationIds.get(key) === operationId
    ) {
      addressBookOperationIds.delete(key);
    }
  }

  function runAddressBookOperation<T>(
    key: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const existing = addressBookOperations.get(key);
    if (existing) return existing as Promise<T>;
    const operation = action();
    addressBookOperations.set(key, operation);
    const clear = () => {
      if (addressBookOperations.get(key) === operation) {
        addressBookOperations.delete(key);
      }
    };
    operation.then(clear, clear);
    return operation;
  }

  async function addressBookFromMutation(
    result: MutationExecution,
    fallbackRemoteId: string | null = null,
  ): Promise<AddressbookRow | null> {
    if (result.addressbooks) {
      addressbooks.value = result.addressbooks;
    } else {
      await refreshAddressbooks();
    }
    const remoteId = result.addressbook?.remote_id
      ?? result.ids?.[0]
      ?? fallbackRemoteId;
    if (!remoteId) return null;
    const cached = addressbooks.value.find((book) => book.remote_id === remoteId);
    if (cached) return cached;
    if (result.addressbook) {
      addressbooks.value = [...addressbooks.value, result.addressbook];
      return result.addressbook;
    }
    return null;
  }

  async function applyAddressBookContinuation(
    operationKey: string,
    addressbook: AddressbookRow,
    fields: AddressBookMutableFields,
  ): Promise<AddressBookSaveResult> {
    const operationId = createAddressBookOperationId();
    addressBookOperationIds.set(operationKey, operationId);
    const request: UpdateAddressBookMutationRequest = {
      operationId,
      addressbookId: addressbook.id,
      ...fields,
    };
    try {
      const result = await queueAndRunResult({
        accountId: authStore.accountId!,
        mutationType: MUTATION_TYPE.UPDATE_ADDRESSBOOK,
        targetMessageId: null,
        requestJson: JSON.stringify(request),
      });
      if (!result.ok) {
        const code = addressBookErrorForMutation(result.errorType);
        finishAddressBookOperation(operationKey, operationId, code);
        return addressBookFailure(code);
      }
      const updated = await addressBookFromMutation(
        result,
        addressbook.remote_id,
      );
      if (!updated) {
        finishAddressBookOperation(
          operationKey,
          operationId,
          ADDRESSBOOK_ERROR.CACHE_REPAIR_FAILED,
        );
        return addressBookFailure(ADDRESSBOOK_ERROR.CACHE_REPAIR_FAILED);
      }
      finishAddressBookOperation(operationKey, operationId, null);
      return { ok: true, addressbook: updated };
    } catch (caught: any) {
      const code = addressBookErrorForMutation(caught?.type);
      finishAddressBookOperation(operationKey, operationId, code);
      return addressBookFailure(code);
    }
  }

  function createAddressBook(
    input: AddressBookCreateInput,
  ): Promise<AddressBookCreateResult> {
    error.value = null;
    const runtimeInput = input as unknown as Record<string, unknown>;
    const name = canonicalAddressBookName(runtimeInput?.name);
    if (!name) {
      return Promise.resolve(addressBookFailure(ADDRESSBOOK_ERROR.INVALID_NAME));
    }
    if (!validAddressBookMetadata(runtimeInput)) {
      return Promise.resolve(addressBookFailure(ADDRESSBOOK_ERROR.INVALID_ARGUMENTS));
    }
    if (!repo || authStore.accountId == null) {
      return Promise.resolve(addressBookFailure(ADDRESSBOOK_ERROR.SERVER_UNAVAILABLE));
    }
    if (!canCreateAddressBook.value) {
      return Promise.resolve(addressBookFailure(ADDRESSBOOK_ERROR.PERMISSION_DENIED));
    }

    const operationKey = `create:${name.toLocaleLowerCase()}`;
    return runAddressBookOperation(operationKey, async () => {
      const operationId = operationIdForAddressBook(
        operationKey,
        typeof input.operationId === 'string' ? input.operationId : undefined,
      );
      const request: CreateAddressBookMutationRequest = {
        operationId,
        name,
        description: typeof input.description === 'string'
          ? canonicalAddressBookText(input.description)
          : null,
        sortOrder: input.sortOrder ?? 0,
        isSubscribed: input.isSubscribed ?? true,
        setAsDefault: input.setAsDefault ?? false,
      };
      saving.value = true;
      try {
        const result = await queueAndRunResult({
          accountId: authStore.accountId!,
          mutationType: MUTATION_TYPE.CREATE_ADDRESSBOOK,
          targetMessageId: null,
          requestJson: JSON.stringify(request),
        });
        if (!result.ok) {
          const code = addressBookErrorForMutation(result.errorType);
          finishAddressBookOperation(operationKey, operationId, code);
          return addressBookFailure(code);
        }
        const created = await addressBookFromMutation(result);
        if (!created) {
          finishAddressBookOperation(
            operationKey,
            operationId,
            ADDRESSBOOK_ERROR.CACHE_REPAIR_FAILED,
          );
          return addressBookFailure(ADDRESSBOOK_ERROR.CACHE_REPAIR_FAILED);
        }
        if (result.requestMatches === false) {
          return applyAddressBookContinuation(operationKey, created, {
            name: request.name,
            description: request.description,
            sortOrder: request.sortOrder,
            isSubscribed: request.isSubscribed,
            ...(request.setAsDefault === true ? { setAsDefault: true } : {}),
          });
        }
        finishAddressBookOperation(operationKey, operationId, null);
        return { ok: true, addressbook: created };
      } catch (caught: any) {
        const code = addressBookErrorForMutation(caught?.type);
        finishAddressBookOperation(operationKey, operationId, code);
        return addressBookFailure(code);
      } finally {
        saving.value = false;
      }
    });
  }

  function updateAddressBook(
    input: AddressBookUpdateInput,
  ): Promise<AddressBookUpdateResult>;
  function updateAddressBook(
    addressbookId: number,
    fields: Omit<AddressBookUpdateInput, 'addressbookId'>,
  ): Promise<AddressBookUpdateResult>;
  function updateAddressBook(
    inputOrId: AddressBookUpdateInput | number,
    fields: Omit<AddressBookUpdateInput, 'addressbookId'> = {},
  ): Promise<AddressBookUpdateResult> {
    error.value = null;
    const input: AddressBookUpdateInput = typeof inputOrId === 'number'
      ? { addressbookId: inputOrId, ...fields }
      : inputOrId;
    const runtimeInput = input as unknown as Record<string, unknown>;
    if (!repo || authStore.accountId == null) {
      return Promise.resolve(addressBookFailure(ADDRESSBOOK_ERROR.SERVER_UNAVAILABLE));
    }
    const current = addressbooks.value.find((book) =>
      book.id === input.addressbookId
      && book.account_id === authStore.accountId
      && book.service_kind === SERVICE_KIND.JMAP_CONTACTS
      && book.is_deleted === 0) ?? null;
    if (!current) {
      return Promise.resolve(addressBookFailure(ADDRESSBOOK_ERROR.MISSING));
    }
    if (hasOwn(runtimeInput, 'name') && !canonicalAddressBookName(input.name)) {
      return Promise.resolve(addressBookFailure(ADDRESSBOOK_ERROR.INVALID_NAME));
    }
    if (!validAddressBookMetadata(runtimeInput)) {
      return Promise.resolve(addressBookFailure(ADDRESSBOOK_ERROR.INVALID_ARGUMENTS));
    }

    const patch: AddressBookMutableFields = {};
    if (hasOwn(runtimeInput, 'name')) {
      patch.name = canonicalAddressBookName(input.name)!;
    }
    if (hasOwn(runtimeInput, 'description')) {
      patch.description = input.description == null
        ? null
        : canonicalAddressBookText(input.description);
    }
    if (hasOwn(runtimeInput, 'sortOrder')) {
      patch.sortOrder = input.sortOrder;
    }
    if (hasOwn(runtimeInput, 'isSubscribed')) {
      patch.isSubscribed = input.isSubscribed;
    }
    if (input.setAsDefault === true) {
      patch.setAsDefault = true;
    }
    if (Object.keys(patch).length === 0) {
      return Promise.resolve({ ok: true, addressbook: current });
    }

    const operationKey = `update:${current.id}`;
    return runAddressBookOperation(operationKey, async () => {
      const operationId = operationIdForAddressBook(
        operationKey,
        typeof input.operationId === 'string' ? input.operationId : undefined,
      );
      const request: UpdateAddressBookMutationRequest = {
        operationId,
        addressbookId: current.id,
        ...patch,
      };
      saving.value = true;
      try {
        const result = await queueAndRunResult({
          accountId: authStore.accountId!,
          mutationType: MUTATION_TYPE.UPDATE_ADDRESSBOOK,
          targetMessageId: null,
          requestJson: JSON.stringify(request),
        });
        if (!result.ok) {
          const code = addressBookErrorForMutation(result.errorType);
          finishAddressBookOperation(operationKey, operationId, code);
          return addressBookFailure(code);
        }
        const updated = await addressBookFromMutation(result, current.remote_id);
        if (!updated) {
          finishAddressBookOperation(
            operationKey,
            operationId,
            ADDRESSBOOK_ERROR.CACHE_REPAIR_FAILED,
          );
          return addressBookFailure(ADDRESSBOOK_ERROR.CACHE_REPAIR_FAILED);
        }
        if (result.requestMatches === false) {
          return applyAddressBookContinuation(operationKey, updated, patch);
        }
        finishAddressBookOperation(operationKey, operationId, null);
        return { ok: true, addressbook: updated };
      } catch (caught: any) {
        const code = addressBookErrorForMutation(caught?.type);
        finishAddressBookOperation(operationKey, operationId, code);
        return addressBookFailure(code);
      } finally {
        saving.value = false;
      }
    });
  }

  function inventoryAddressBook(
    addressbookId: number,
  ): Promise<AddressBookInventoryResult> {
    error.value = null;
    if (!repo || authStore.accountId == null) {
      return Promise.resolve(addressBookFailure(ADDRESSBOOK_ERROR.SERVER_UNAVAILABLE));
    }
    const current = addressbooks.value.find((book) =>
      book.id === addressbookId
      && book.account_id === authStore.accountId
      && book.service_kind === SERVICE_KIND.JMAP_CONTACTS
      && book.is_deleted === 0) ?? null;
    if (!current) {
      return Promise.resolve(addressBookFailure(ADDRESSBOOK_ERROR.MISSING));
    }
    return runAddressBookOperation(`inventory:${addressbookId}`, async () => {
      try {
        const inventory = await repo!.inventoryAddressbook(
          authStore.accountId!,
          addressbookId,
        );
        return { ok: true, inventory };
      } catch (caught: any) {
        return addressBookFailure(addressBookErrorForMutation(caught?.type));
      }
    });
  }

  function deleteAddressBook(
    input: AddressBookDeleteInput,
  ): Promise<AddressBookDeleteResult>;
  function deleteAddressBook(
    addressbookId: number,
    confirmationInventory: AddressBookInventory,
    operationId?: string,
  ): Promise<AddressBookDeleteResult>;
  function deleteAddressBook(
    inputOrId: AddressBookDeleteInput | number,
    confirmationInventory?: AddressBookInventory,
    operationId?: string,
  ): Promise<AddressBookDeleteResult> {
    error.value = null;
    const input: AddressBookDeleteInput = typeof inputOrId === 'number'
      ? {
          addressbookId: inputOrId,
          confirmationInventory: confirmationInventory!,
          operationId,
        }
      : inputOrId;
    if (!repo || authStore.accountId == null) {
      return Promise.resolve(addressBookFailure(ADDRESSBOOK_ERROR.SERVER_UNAVAILABLE));
    }
    const current = addressbooks.value.find((book) =>
      book.id === input.addressbookId
      && book.account_id === authStore.accountId
      && book.service_kind === SERVICE_KIND.JMAP_CONTACTS
      && book.is_deleted === 0) ?? null;
    if (!current) {
      return Promise.resolve(addressBookFailure(ADDRESSBOOK_ERROR.MISSING));
    }
    if (current.may_delete !== 1) {
      return Promise.resolve(addressBookFailure(ADDRESSBOOK_ERROR.PERMISSION_DENIED));
    }
    if (isTrustedSendersBook(current)) {
      return Promise.resolve(addressBookFailure(ADDRESSBOOK_ERROR.PROTECTED));
    }
    const personalBooks = addressbooks.value.filter((book) =>
      book.account_id === authStore.accountId
      && book.service_kind === SERVICE_KIND.JMAP_CONTACTS
      && book.is_deleted === 0
      && !isTrustedSendersBook(book));
    if (personalBooks.length <= 1) {
      return Promise.resolve(addressBookFailure(ADDRESSBOOK_ERROR.LAST_ADDRESSBOOK));
    }
    if (
      !input.confirmationInventory
      || input.confirmationInventory.addressbookId !== current.id
      || input.confirmationInventory.addressBookRemoteId !== current.remote_id
    ) {
      return Promise.resolve(
        addressBookFailure(ADDRESSBOOK_ERROR.CONFIRMATION_REQUIRED),
      );
    }

    const operationKey = `delete:${current.id}`;
    return runAddressBookOperation(operationKey, async () => {
      const stableOperationId = operationIdForAddressBook(
        operationKey,
        typeof input.operationId === 'string' ? input.operationId : undefined,
      );
      const request: DestroyAddressBookMutationRequest = {
        operationId: stableOperationId,
        addressbookId: current.id,
        confirmationInventory: input.confirmationInventory,
      };
      deletingAddressBookIds.value = [
        ...new Set([...deletingAddressBookIds.value, current.id]),
      ];
      try {
        const result = await queueAndRunResult({
          accountId: authStore.accountId!,
          mutationType: MUTATION_TYPE.DESTROY_ADDRESSBOOK,
          targetMessageId: null,
          requestJson: JSON.stringify(request),
        });
        if (!result.ok) {
          const code = addressBookErrorForMutation(result.errorType);
          finishAddressBookOperation(operationKey, stableOperationId, code);
          return addressBookFailure(code);
        }
        if (result.addressbooks) {
          addressbooks.value = result.addressbooks;
        } else {
          await refreshAddressbooks();
        }
        await refreshContacts();
        finishAddressBookOperation(operationKey, stableOperationId, null);
        return { ok: true };
      } catch (caught: any) {
        const code = addressBookErrorForMutation(caught?.type);
        finishAddressBookOperation(operationKey, stableOperationId, code);
        return addressBookFailure(code);
      } finally {
        deletingAddressBookIds.value = deletingAddressBookIds.value
          .filter((id) => id !== current.id);
      }
    });
  }

  function identityErrorForMutation(errorType?: string): IdentityError {
    switch (errorType) {
      case IDENTITY_ERROR.INVALID_REPLY_TO:
        return IDENTITY_ERROR.INVALID_REPLY_TO;
      case IDENTITY_ERROR.INVALID_BCC:
        return IDENTITY_ERROR.INVALID_BCC;
      case IDENTITY_ERROR.SIGNATURE_TOO_LARGE:
        return IDENTITY_ERROR.SIGNATURE_TOO_LARGE;
      case IDENTITY_ERROR.INVALID_SIGNATURE:
        return IDENTITY_ERROR.INVALID_SIGNATURE;
      case IDENTITY_ERROR.IMMUTABLE_FIELD:
        return IDENTITY_ERROR.IMMUTABLE_FIELD;
      case IDENTITY_ERROR.ADDRESS_NOT_CONFIGURED:
      case 'forbiddenFrom':
        return IDENTITY_ERROR.ADDRESS_NOT_CONFIGURED;
      case IDENTITY_ERROR.OVER_QUOTA:
      case 'overQuota':
        return IDENTITY_ERROR.OVER_QUOTA;
      case IDENTITY_ERROR.OBJECT_TOO_LARGE:
      case 'tooLarge':
        return IDENTITY_ERROR.OBJECT_TOO_LARGE;
      case IDENTITY_ERROR.INVALID_PATCH:
      case 'invalidPatch':
        return IDENTITY_ERROR.INVALID_PATCH;
      case IDENTITY_ERROR.WILL_DESTROY:
      case 'willDestroy':
        return IDENTITY_ERROR.WILL_DESTROY;
      case IDENTITY_ERROR.SINGLETON:
      case 'singleton':
        return IDENTITY_ERROR.SINGLETON;
      case IDENTITY_ERROR.INVALID_ARGUMENTS:
      case 'invalidArguments':
        return IDENTITY_ERROR.INVALID_ARGUMENTS;
      case IDENTITY_ERROR.AMBIGUOUS_CREATE:
      case 'createOutcomeUnknown':
        return IDENTITY_ERROR.AMBIGUOUS_CREATE;
      case IDENTITY_ERROR.INVALID_EMAIL:
        return IDENTITY_ERROR.INVALID_EMAIL;
      case IDENTITY_ERROR.INVALID_NAME:
      case 'invalidName':
        return IDENTITY_ERROR.INVALID_NAME;
      case IDENTITY_ERROR.MISSING:
      case 'notFound':
      case 'unknownIdentity':
        return IDENTITY_ERROR.MISSING;
      case IDENTITY_ERROR.PERMISSION_DENIED:
      case 'accountNotFound':
      case 'accountNotSupportedByMethod':
      case 'accountReadOnly':
      case 'authenticationFailed':
      case 'authorizationFailed':
      case 'forbidden':
        return IDENTITY_ERROR.PERMISSION_DENIED;
      case IDENTITY_ERROR.CACHE_REPAIR_FAILED:
      case 'cacheReconcileFailed':
        return IDENTITY_ERROR.CACHE_REPAIR_FAILED;
      case IDENTITY_ERROR.SERVER_UNAVAILABLE:
      case 'noResponse':
      case 'rateLimit':
      case 'serverFail':
      case 'serverUnavailable':
      case 'stopped':
      case 'transport':
        return IDENTITY_ERROR.SERVER_UNAVAILABLE;
      default:
        return IDENTITY_ERROR.UNKNOWN;
    }
  }

  function identityFailure(code: IdentityError): { ok: false; error: IdentityError } {
    error.value = IDENTITY_ERROR_MESSAGE[code];
    return { ok: false, error: code };
  }

  function operationIdForIdentity(
    key: string,
    supplied: string | undefined,
  ): string {
    const existing = identityOperationIds.get(key);
    if (existing) return existing;
    const operationId = supplied ?? createIdentityOperationId();
    identityOperationIds.set(key, operationId);
    return operationId;
  }

  function finishIdentityOperation(key: string, errorCode: IdentityError | null): void {
    if (
      errorCode !== IDENTITY_ERROR.CACHE_REPAIR_FAILED
      && errorCode !== IDENTITY_ERROR.AMBIGUOUS_CREATE
      && errorCode !== IDENTITY_ERROR.SERVER_UNAVAILABLE
    ) {
      identityOperationIds.delete(key);
    }
  }

  async function identityFromMutation(
    result: MutationExecution,
    remoteId: string | null = null,
  ): Promise<IdentityRow | null> {
    await refreshIdentities();
    const confirmedRemoteId = result.identity?.remote_id ?? result.ids?.[0] ?? remoteId;
    if (!confirmedRemoteId) return null;
    const cached = identities.value.find((identity) =>
      identity.remote_id === confirmedRemoteId) ?? result.identity ?? null;
    if (cached && !identities.value.some((identity) => identity.id === cached.id)) {
      identities.value = [...identities.value, cached];
    }
    return cached;
  }

  function storedIdentityRequest(result: MutationExecution): Record<string, unknown> | null {
    if (!result.storedRequestJson) return null;
    try {
      const request = JSON.parse(result.storedRequestJson);
      return request && typeof request === 'object' ? request : null;
    } catch {
      return null;
    }
  }

  async function applyIdentityContinuation(
    operationKey: string,
    remoteId: string,
    fields: IdentityMutableFields,
  ): Promise<IdentitySaveResult> {
    if (Object.keys(fields).length === 0) {
      finishIdentityOperation(operationKey, IDENTITY_ERROR.INVALID_PATCH);
      return identityFailure(IDENTITY_ERROR.INVALID_PATCH);
    }
    const nextOperationId = createIdentityOperationId();
    identityOperationIds.set(operationKey, nextOperationId);
    const request: UpdateIdentityMutationRequest = {
      operationId: nextOperationId,
      remoteId,
      ...fields,
    };
    const result = await queueAndRunResult({
      accountId: authStore.accountId!,
      mutationType: MUTATION_TYPE.UPDATE_IDENTITY,
      targetMessageId: null,
      requestJson: JSON.stringify(request),
    });
    if (!result.ok) {
      const code = identityErrorForMutation(result.errorType);
      finishIdentityOperation(operationKey, code);
      return identityFailure(code);
    }
    const identity = await identityFromMutation(result, remoteId);
    if (!identity) {
      finishIdentityOperation(operationKey, IDENTITY_ERROR.CACHE_REPAIR_FAILED);
      return identityFailure(IDENTITY_ERROR.CACHE_REPAIR_FAILED);
    }
    finishIdentityOperation(operationKey, null);
    return { ok: true, identity };
  }

  async function createIdentity(
    input: IdentityCreateInput,
  ): Promise<IdentitySaveResult> {
    error.value = null;
    const email = parseIdentityMailbox(input.email);
    if (!email) {
      return identityFailure(IDENTITY_ERROR.INVALID_EMAIL);
    }
    const prepared = preparedIdentityFields(input as unknown as Record<string, unknown>);
    if (prepared.error) return identityFailure(prepared.error);
    if (!repo || authStore.accountId == null) {
      return identityFailure(IDENTITY_ERROR.NOT_CONNECTED);
    }
    const operationKey = `create:${email.toLowerCase()}`;
    const operationId = operationIdForIdentity(operationKey, input.operationId);
    const request: CreateIdentityMutationRequest = {
      operationId,
      email,
      ...prepared.fields,
    };
    saving.value = true;
    try {
      const result = await queueAndRunResult({
        accountId: authStore.accountId,
        mutationType: MUTATION_TYPE.CREATE_IDENTITY,
        targetMessageId: null,
        requestJson: JSON.stringify(request),
      });
      if (!result.ok) {
        const code = identityErrorForMutation(result.errorType);
        finishIdentityOperation(operationKey, code);
        return identityFailure(code);
      }
      const identity = await identityFromMutation(result);
      if (!identity) {
        finishIdentityOperation(operationKey, IDENTITY_ERROR.CACHE_REPAIR_FAILED);
        return identityFailure(IDENTITY_ERROR.CACHE_REPAIR_FAILED);
      }
      if (result.requestMatches === false) {
        const stored = storedIdentityRequest(result);
        if (
          typeof stored?.email !== 'string'
          || stored.email.toLowerCase() !== email.toLowerCase()
        ) {
          finishIdentityOperation(operationKey, IDENTITY_ERROR.IMMUTABLE_FIELD);
          return identityFailure(IDENTITY_ERROR.IMMUTABLE_FIELD);
        }
        return applyIdentityContinuation(
          operationKey,
          identity.remote_id,
          prepared.fields,
        );
      }
      finishIdentityOperation(operationKey, null);
      return { ok: true, identity };
    } catch {
      finishIdentityOperation(operationKey, IDENTITY_ERROR.SERVER_UNAVAILABLE);
      return identityFailure(IDENTITY_ERROR.SERVER_UNAVAILABLE);
    } finally {
      saving.value = false;
    }
  }

  async function updateIdentity(
    input: IdentityUpdateInput,
  ): Promise<IdentitySaveResult> {
    error.value = null;
    const runtimeInput = input as unknown as Record<string, unknown>;
    if (
      hasOwn(runtimeInput, 'email')
      || hasOwn(runtimeInput, 'id')
      || hasOwn(runtimeInput, 'mayDelete')
    ) {
      return identityFailure(IDENTITY_ERROR.IMMUTABLE_FIELD);
    }
    const prepared = preparedIdentityFields(runtimeInput);
    if (prepared.error) return identityFailure(prepared.error);
    if (!repo || authStore.accountId == null) {
      return identityFailure(IDENTITY_ERROR.NOT_CONNECTED);
    }
    if (Object.keys(prepared.fields).length === 0) {
      const identity = identities.value.find((entry) =>
        entry.remote_id === input.remoteId) ?? null;
      return identity
        ? { ok: true, identity }
        : identityFailure(IDENTITY_ERROR.MISSING);
    }
    const operationKey = `update:${input.remoteId}`;
    const operationId = operationIdForIdentity(operationKey, input.operationId);
    const request: UpdateIdentityMutationRequest = {
      operationId,
      remoteId: input.remoteId,
      ...prepared.fields,
    };
    saving.value = true;
    try {
      const result = await queueAndRunResult({
        accountId: authStore.accountId,
        mutationType: MUTATION_TYPE.UPDATE_IDENTITY,
        targetMessageId: null,
        requestJson: JSON.stringify(request),
      });
      if (!result.ok) {
        const code = identityErrorForMutation(result.errorType);
        finishIdentityOperation(operationKey, code);
        return identityFailure(code);
      }
      const identity = await identityFromMutation(result, input.remoteId);
      if (!identity) {
        finishIdentityOperation(operationKey, IDENTITY_ERROR.CACHE_REPAIR_FAILED);
        return identityFailure(IDENTITY_ERROR.CACHE_REPAIR_FAILED);
      }
      if (result.requestMatches === false) {
        return applyIdentityContinuation(
          operationKey,
          input.remoteId,
          prepared.fields,
        );
      }
      finishIdentityOperation(operationKey, null);
      return { ok: true, identity };
    } catch {
      finishIdentityOperation(operationKey, IDENTITY_ERROR.SERVER_UNAVAILABLE);
      return identityFailure(IDENTITY_ERROR.SERVER_UNAVAILABLE);
    } finally {
      saving.value = false;
    }
  }

  async function deleteIdentity(identity: IdentityRow): Promise<IdentityActionResult> {
    error.value = null;
    if (identity.may_delete !== 1) {
      return identityFailure(IDENTITY_ERROR.PERMISSION_DENIED);
    }
    if (!repo || authStore.accountId == null) {
      return identityFailure(IDENTITY_ERROR.NOT_CONNECTED);
    }
    const operationKey = `delete:${identity.remote_id}`;
    const operationId = operationIdForIdentity(operationKey, undefined);
    deletingIdentityIds.value = [...deletingIdentityIds.value, identity.id];
    const previous = identities.value;
    identities.value = previous.filter((entry) => entry.id !== identity.id);
    try {
      const result = await queueAndRunResult({
        accountId: authStore.accountId,
        mutationType: MUTATION_TYPE.DELETE_IDENTITY,
        targetMessageId: null,
        requestJson: JSON.stringify({
          operationId,
          remoteId: identity.remote_id,
        }),
      });
      if (!result.ok) {
        const code = identityErrorForMutation(result.errorType);
        finishIdentityOperation(operationKey, code);
        await refreshIdentities();
        return identityFailure(code);
      }
      finishIdentityOperation(operationKey, null);
      return { ok: true };
    } catch {
      finishIdentityOperation(operationKey, IDENTITY_ERROR.SERVER_UNAVAILABLE);
      await refreshIdentities();
      return identityFailure(IDENTITY_ERROR.SERVER_UNAVAILABLE);
    } finally {
      deletingIdentityIds.value = deletingIdentityIds.value
        .filter((id) => id !== identity.id);
    }
  }

  return {
    addressbooks,
    canCreateAddressBook,
    contacts,
    trash,
    identities,
    error,
    saving,
    deletingIds,
    movingIds,
    restoringTrashIds,
    deletingTrashIds,
    deletingIdentityIds,
    deletingAddressBookIds,
    $reset,
    attach,
    detach,
    refresh,
    refreshAddressBookCapability,
    refreshAddressbooks,
    refreshContacts,
    refreshTrash,
    refreshIdentities,
    listContacts,
    listIdentities,
    getContact,
    getContactTrash,
    autocomplete,
    createContact,
    createContactResult,
    updateContact,
    deleteContact,
    deleteContacts,
    moveContacts,
    restoreContactTrash,
    deleteContactTrashForever,
    createAddressBook,
    updateAddressBook,
    inventoryAddressBook,
    deleteAddressBook,
    createIdentity,
    updateIdentity,
    deleteIdentity,
  };
});
