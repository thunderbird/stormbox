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
  addressBookErrorMessage,
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
  DeleteIdentityMutationRequest,
  DestroyAddressBookMutationRequest,
  IdentityAddress,
  IdentityMutableFields,
  IdentityRow,
  UpdateAddressBookMutationRequest,
  UpdateContactMutationRequest,
  UpdateIdentityMutationRequest,
} from '../types';
import type { Repository } from '../db/repository';
import {
  addressBookDeleteDisabledReason,
} from '../utils/address-book-policy';
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

function autocompleteCandidate(
  contact: ContactListRow,
): AutocompleteCandidate | null {
  if (!contact.email) return null;
  return {
    ...(contact.display_name ? { name: contact.display_name } : {}),
    email: contact.email,
    source: 'contact',
  };
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
      uid?: string;
    }
  | {
      name?: string | null;
      emails: string[];
      addressbookId?: number | null;
      uid?: string;
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
      status: 'hydrated';
      uid: string;
      contactId: number;
      detail: ContactDetail;
    }
  | {
      ok: true;
      status: 'persisted';
      uid: string;
      contactId: number | null;
      detail: null;
    }
  | {
      ok: false;
      status: 'failed';
      uid: string | null;
    };

export type ContactBatchActionResult = ContactBatchMutationResult & {
  ok: boolean;
};

export type ContactTrashActionResult = ContactTrashMutationResult & {
  ok: boolean;
};

export const CONTACT_MISSING_MESSAGE =
  'This contact no longer exists. Discard these changes or create a new contact.';

function failedContactCreate(uid: string | null = null): ContactCreateResult {
  return {
    ok: false,
    status: 'failed',
    uid,
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

/**
 * Failures whose server outcome is unknown or that will pass on retry; the
 * operation keeps its id so the retry lands on the same at-most-once write.
 */
const ADDRESSBOOK_STICKY_ERRORS: ReadonlySet<AddressBookError> = new Set([
  ADDRESSBOOK_ERROR.AMBIGUOUS_CREATE,
  ADDRESSBOOK_ERROR.CACHE_REPAIR_FAILED,
  ADDRESSBOOK_ERROR.SERVER_UNAVAILABLE,
]);

const IDENTITY_STICKY_ERRORS: ReadonlySet<IdentityError> = new Set([
  IDENTITY_ERROR.AMBIGUOUS_CREATE,
  IDENTITY_ERROR.CACHE_REPAIR_FAILED,
  IDENTITY_ERROR.SERVER_UNAVAILABLE,
]);

type MutationFailure<E extends string> = { ok: false; error: E };

/** Operation ids held per operation key for one mutation family. */
interface OperationTracker<E extends string> {
  /** The id the key already holds, else `supplied` or a fresh one. */
  claim(key: string, supplied: string | undefined): string;
  /** Hands the key to a fresh id for a continuation. */
  replace(key: string): string;
  /**
   * Releases the key once the operation that owns it settles without a
   * sticky error; a stale finish from a superseded operation is a no-op.
   */
  finish(key: string, operationId: string, errorCode: E | null): void;
  clear(): void;
}

function createOperationTracker<E extends string>(
  createOperationId: () => string,
  stickyErrors: ReadonlySet<E>,
): OperationTracker<E> {
  const operationIds = new Map<string, string>();
  return {
    claim(key, supplied) {
      const existing = operationIds.get(key);
      if (existing) return existing;
      const operationId = supplied ?? createOperationId();
      operationIds.set(key, operationId);
      return operationId;
    },
    replace(key) {
      const operationId = createOperationId();
      operationIds.set(key, operationId);
      return operationId;
    },
    finish(key, operationId, errorCode) {
      if (operationIds.get(key) !== operationId) return;
      if (errorCode != null && stickyErrors.has(errorCode)) return;
      operationIds.delete(key);
    },
    clear() {
      operationIds.clear();
    },
  };
}

interface MutationFamilyOptions<E extends string> {
  createOperationId(): string;
  stickyErrors: ReadonlySet<E>;
  errorForMutation(errorType?: string): E;
  errorForThrown(caught: unknown): E;
  failure(code: E): MutationFailure<E>;
}

interface TrackedMutationRun<E extends string, TResult extends { ok: boolean }> {
  operationKey: string;
  operationId: string;
  mutationType: MutationType;
  request: object;
  /** Brackets the run: busy indicators and optimistic state. */
  begin?(): void;
  end?(): void;
  /**
   * Turns an acknowledged execution into the run's result. An error code
   * fails the run; a result stands as-is, including one a continuation
   * produced under its own operation id.
   */
  settle(result: MutationExecution): Promise<TResult | E>;
  /** Runs before any failure is returned. */
  onFailure?(): Promise<void>;
}

interface MutationFamily<E extends string> {
  operations: OperationTracker<E>;
  run<TResult extends { ok: boolean }>(
    spec: TrackedMutationRun<E, TResult>,
  ): Promise<TResult | MutationFailure<E>>;
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
  const addressBookMutations = createMutationFamily<AddressBookError>({
    createOperationId: createAddressBookOperationId,
    stickyErrors: ADDRESSBOOK_STICKY_ERRORS,
    errorForMutation: addressBookErrorForMutation,
    errorForThrown: (caught: any) => addressBookErrorForMutation(caught?.type),
    failure: addressBookFailure,
  });
  const identityMutations = createMutationFamily<IdentityError>({
    createOperationId: createIdentityOperationId,
    stickyErrors: IDENTITY_STICKY_ERRORS,
    errorForMutation: identityErrorForMutation,
    // Anything thrown while an identity write runs reads as an outage.
    errorForThrown: () => IDENTITY_ERROR.SERVER_UNAVAILABLE,
    failure: identityFailure,
  });
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
    identityMutations.operations.clear();
    addressBookMutations.operations.clear();
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

  async function browseAutocompleteCandidates(): Promise<AutocompleteCandidate[]> {
    const accountId = authStore.accountId;
    if (accountId == null) return [];
    const repository = repo ?? await getRepositoryAsync();
    if (authStore.accountId !== accountId) return [];
    const rows = await repository.listContacts(accountId);
    if (authStore.accountId !== accountId) return [];
    return rows.flatMap((contact) => {
      const candidate = autocompleteCandidate(contact);
      return candidate ? [candidate] : [];
    });
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
   * One at-most-once mutation family (address books, identities): its
   * operation ids plus the runner every create/update/delete goes through,
   * so tracking, error mapping, and cleanup are shared.
   */
  function createMutationFamily<E extends string>(
    options: MutationFamilyOptions<E>,
  ): MutationFamily<E> {
    const operations = createOperationTracker(
      options.createOperationId,
      options.stickyErrors,
    );

    async function run<TResult extends { ok: boolean }>(
      spec: TrackedMutationRun<E, TResult>,
    ): Promise<TResult | MutationFailure<E>> {
      const fail = async (code: E): Promise<MutationFailure<E>> => {
        operations.finish(spec.operationKey, spec.operationId, code);
        await spec.onFailure?.();
        return options.failure(code);
      };
      spec.begin?.();
      try {
        const result = await queueAndRunResult({
          accountId: authStore.accountId!,
          mutationType: spec.mutationType,
          targetMessageId: null,
          requestJson: JSON.stringify(spec.request),
        });
        if (!result.ok) return await fail(options.errorForMutation(result.errorType));
        const outcome = await spec.settle(result);
        if (typeof outcome === 'string') return await fail(outcome);
        // A continuation takes the key over under its own id before it
        // runs, so this only releases a key the run itself still holds.
        operations.finish(spec.operationKey, spec.operationId, null);
        return outcome;
      } catch (caught) {
        return await fail(options.errorForThrown(caught));
      } finally {
        spec.end?.();
      }
    }

    return { operations, run };
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
  ): Promise<ContactCreateResult> {
    error.value = null;
    const retryUid = normalizeContactUid(input.uid);
    if (!repo || authStore.accountId == null) {
      error.value = 'Not connected.';
      return failedContactCreate(retryUid);
    }
    let fields: ContactMutationFields;
    let selectedAddressbookIds: number[];
    if ('contact' in input) {
      fields = withContactDetailKeys(input.contact, null);
      selectedAddressbookIds = input.addressbookIds ?? [];
    } else {
      const name = input.name?.trim() || null;
      fields = legacyCreateContactFields(name, input.emails);
      selectedAddressbookIds = input.addressbookId == null ? [] : [input.addressbookId];
    }
    const invalid = invalidContactFields(fields);
    if (invalid) {
      error.value = invalid;
      return failedContactCreate(retryUid);
    }
    if (contactFieldsAreEmpty(fields)) {
      error.value = 'Enter at least one contact detail.';
      return failedContactCreate(retryUid);
    }
    const uid = retryUid ?? createContactUid();
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
        return failedContactCreate(uid);
      }
      await refreshContacts();
      const normalizedUid = normalizeContactUid(uid);
      const remoteIds = new Set(mutation.ids ?? []);
      const created = contacts.value.find((contact) =>
        contact.remote_id != null && remoteIds.has(contact.remote_id))
        ?? contacts.value.find((contact) =>
          normalizeContactUid(contact.uid) === normalizedUid)
        ?? null;
      let detail: ContactDetail | null = null;
      if (created) {
        try {
          detail = await repo.getContact(authStore.accountId, created.id);
        } catch (err: any) {
          error.value = err?.message ?? String(err);
        }
      }
      if (created && detail) {
        return {
          ok: true,
          status: 'hydrated',
          uid,
          contactId: created.id,
          detail,
        };
      }
      return {
        ok: true,
        status: 'persisted',
        uid,
        contactId: created?.id ?? null,
        detail: null,
      };
    } catch (err: any) {
      error.value = err?.message ?? String(err);
      return failedContactCreate(uid);
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
    return executeContactCreate(input);
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
      next = legacyUpdatedContactFields(
        baseline,
        input.name?.trim() || null,
        input.emails,
      );
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
    error.value = addressBookErrorMessage(code);
    return { ok: false, error: code };
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
    const operationId = addressBookMutations.operations.replace(operationKey);
    const request: UpdateAddressBookMutationRequest = {
      operationId,
      addressbookId: addressbook.id,
      ...fields,
    };
    return addressBookMutations.run<AddressBookSaveResult>({
      operationKey,
      operationId,
      mutationType: MUTATION_TYPE.UPDATE_ADDRESSBOOK,
      request,
      settle: async (result) => {
        const updated = await addressBookFromMutation(result, addressbook.remote_id);
        return updated
          ? { ok: true, addressbook: updated }
          : ADDRESSBOOK_ERROR.CACHE_REPAIR_FAILED;
      },
    });
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
      const operationId = addressBookMutations.operations.claim(
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
      return addressBookMutations.run<AddressBookSaveResult>({
        operationKey,
        operationId,
        mutationType: MUTATION_TYPE.CREATE_ADDRESSBOOK,
        request,
        begin: () => { saving.value = true; },
        end: () => { saving.value = false; },
        settle: async (result) => {
          const created = await addressBookFromMutation(result);
          if (!created) return ADDRESSBOOK_ERROR.CACHE_REPAIR_FAILED;
          if (result.requestMatches === false) {
            return applyAddressBookContinuation(operationKey, created, {
              name: request.name,
              description: request.description,
              sortOrder: request.sortOrder,
              isSubscribed: request.isSubscribed,
              ...(request.setAsDefault === true ? { setAsDefault: true } : {}),
            });
          }
          return { ok: true, addressbook: created };
        },
      });
    });
  }

  function updateAddressBook(
    input: AddressBookUpdateInput,
  ): Promise<AddressBookUpdateResult> {
    error.value = null;
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
      const operationId = addressBookMutations.operations.claim(
        operationKey,
        typeof input.operationId === 'string' ? input.operationId : undefined,
      );
      const request: UpdateAddressBookMutationRequest = {
        operationId,
        addressbookId: current.id,
        ...patch,
      };
      return addressBookMutations.run<AddressBookSaveResult>({
        operationKey,
        operationId,
        mutationType: MUTATION_TYPE.UPDATE_ADDRESSBOOK,
        request,
        begin: () => { saving.value = true; },
        end: () => { saving.value = false; },
        settle: async (result) => {
          const updated = await addressBookFromMutation(result, current.remote_id);
          if (!updated) return ADDRESSBOOK_ERROR.CACHE_REPAIR_FAILED;
          if (result.requestMatches === false) {
            return applyAddressBookContinuation(operationKey, updated, patch);
          }
          return { ok: true, addressbook: updated };
        },
      });
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
  ): Promise<AddressBookDeleteResult> {
    error.value = null;
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
    const personalBooks = addressbooks.value.filter((book) =>
      book.account_id === authStore.accountId
      && book.service_kind === SERVICE_KIND.JMAP_CONTACTS
      && book.is_deleted === 0);
    const disabledReason = addressBookDeleteDisabledReason(
      current,
      personalBooks,
    );
    if (disabledReason) {
      return Promise.resolve(addressBookFailure(disabledReason));
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
      const operationId = addressBookMutations.operations.claim(
        operationKey,
        typeof input.operationId === 'string' ? input.operationId : undefined,
      );
      const request: DestroyAddressBookMutationRequest = {
        operationId,
        addressbookId: current.id,
        confirmationInventory: input.confirmationInventory,
      };
      return addressBookMutations.run<AddressBookDeleteResult>({
        operationKey,
        operationId,
        mutationType: MUTATION_TYPE.DESTROY_ADDRESSBOOK,
        request,
        begin: () => {
          deletingAddressBookIds.value = [
            ...new Set([...deletingAddressBookIds.value, current.id]),
          ];
        },
        end: () => {
          deletingAddressBookIds.value = deletingAddressBookIds.value
            .filter((id) => id !== current.id);
        },
        settle: async (result) => {
          if (result.addressbooks) {
            addressbooks.value = result.addressbooks;
          } else {
            await refreshAddressbooks();
          }
          await refreshContacts();
          return { ok: true };
        },
      });
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
    operationId: string,
    remoteId: string,
    fields: IdentityMutableFields,
  ): Promise<IdentitySaveResult> {
    if (Object.keys(fields).length === 0) {
      identityMutations.operations.finish(
        operationKey,
        operationId,
        IDENTITY_ERROR.INVALID_PATCH,
      );
      return identityFailure(IDENTITY_ERROR.INVALID_PATCH);
    }
    const nextOperationId = identityMutations.operations.replace(operationKey);
    const request: UpdateIdentityMutationRequest = {
      operationId: nextOperationId,
      remoteId,
      ...fields,
    };
    return identityMutations.run<IdentitySaveResult>({
      operationKey,
      operationId: nextOperationId,
      mutationType: MUTATION_TYPE.UPDATE_IDENTITY,
      request,
      settle: async (result) => {
        const identity = await identityFromMutation(result, remoteId);
        return identity ? { ok: true, identity } : IDENTITY_ERROR.CACHE_REPAIR_FAILED;
      },
    });
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
    const operationId = identityMutations.operations.claim(operationKey, input.operationId);
    const request: CreateIdentityMutationRequest = {
      operationId,
      email,
      ...prepared.fields,
    };
    return identityMutations.run<IdentitySaveResult>({
      operationKey,
      operationId,
      mutationType: MUTATION_TYPE.CREATE_IDENTITY,
      request,
      begin: () => { saving.value = true; },
      end: () => { saving.value = false; },
      settle: async (result) => {
        const identity = await identityFromMutation(result);
        if (!identity) return IDENTITY_ERROR.CACHE_REPAIR_FAILED;
        if (result.requestMatches === false) {
          const stored = storedIdentityRequest(result);
          if (
            typeof stored?.email !== 'string'
            || stored.email.toLowerCase() !== email.toLowerCase()
          ) {
            return IDENTITY_ERROR.IMMUTABLE_FIELD;
          }
          return applyIdentityContinuation(
            operationKey,
            operationId,
            identity.remote_id,
            prepared.fields,
          );
        }
        return { ok: true, identity };
      },
    });
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
    const operationId = identityMutations.operations.claim(operationKey, input.operationId);
    const request: UpdateIdentityMutationRequest = {
      operationId,
      remoteId: input.remoteId,
      ...prepared.fields,
    };
    return identityMutations.run<IdentitySaveResult>({
      operationKey,
      operationId,
      mutationType: MUTATION_TYPE.UPDATE_IDENTITY,
      request,
      begin: () => { saving.value = true; },
      end: () => { saving.value = false; },
      settle: async (result) => {
        const identity = await identityFromMutation(result, input.remoteId);
        if (!identity) return IDENTITY_ERROR.CACHE_REPAIR_FAILED;
        if (result.requestMatches === false) {
          return applyIdentityContinuation(
            operationKey,
            operationId,
            input.remoteId,
            prepared.fields,
          );
        }
        return { ok: true, identity };
      },
    });
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
    const operationId = identityMutations.operations.claim(operationKey, undefined);
    const request: DeleteIdentityMutationRequest = {
      operationId,
      remoteId: identity.remote_id,
    };
    return identityMutations.run<IdentityActionResult>({
      operationKey,
      operationId,
      mutationType: MUTATION_TYPE.DELETE_IDENTITY,
      request,
      begin: () => {
        deletingIdentityIds.value = [...deletingIdentityIds.value, identity.id];
        identities.value = identities.value.filter((entry) => entry.id !== identity.id);
      },
      end: () => {
        deletingIdentityIds.value = deletingIdentityIds.value
          .filter((id) => id !== identity.id);
      },
      settle: async () => ({ ok: true }),
      // The optimistic removal is undone from the cache on any failure.
      onFailure: () => refreshIdentities(),
    });
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
    browseAutocompleteCandidates,
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
