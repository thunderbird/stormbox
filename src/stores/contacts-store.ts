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
  IDENTITY_ERROR,
  IDENTITY_ERROR_MESSAGE,
} from '../constants/identity-errors';
import type {
  IdentityActionResult,
  IdentityError,
} from '../constants/identity-errors';
import { MUTATION_TYPE } from '../constants/states';
import type { MutationType } from '../constants/states';
import { TABLE_FAMILIES } from '../db/protocol';
import type { AddressbookRow, ContactListRow, IdentityRow } from '../types';
import type { Repository } from '../db/repository';
import { addressKey } from '../utils/address-key';

interface PendingMutationInsert {
  accountId: number;
  mutationType: MutationType;
  targetMessageId: number | null;
  requestJson: string;
}

interface MutationExecution {
  ok: boolean;
  errorType?: string;
}

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

export interface ContactDetailEmail {
  email: string;
  label: string | null;
  is_preferred: 0 | 1;
  position: number;
}

export interface ContactDetail {
  id: number;
  remote_id: string | null;
  addressbook_ids: number[];
  display_name: string | null;
  full_name: string | null;
  organization: string | null;
  emails: ContactDetailEmail[];
}

export const useContactsStore = defineStore('contacts', () => {
  const authStore = useAuthStore();
  const addressbooks = ref<AddressbookRow[]>([]);
  const contacts = ref<ContactListRow[]>([]);
  const identities = ref<IdentityRow[]>([]);
  const error = ref<string | null>(null);
  const saving = ref(false);
  const deletingIds = ref<number[]>([]);
  const deletingIdentityIds = ref<number[]>([]);
  let repo: Repository | null = null;
  let unsubscribe: (() => void) | null = null;

  async function attach(): Promise<void> {
    if (repo) return;
    repo = await getRepositoryAsync();
    unsubscribe = repo.subscribe(onTablesTouched);
    watch(
      () => authStore.accountId,
      async (newId) => {
        if (newId) {
          await refresh();
          return;
        }
        $reset();
      },
      { immediate: true },
    );
  }

  function detach(): void {
    unsubscribe?.();
    unsubscribe = null;
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
    contacts.value = [];
    identities.value = [];
    error.value = null;
    saving.value = false;
    deletingIds.value = [];
    deletingIdentityIds.value = [];
  }

  function onTablesTouched(tables: string[]): void {
    if (authStore.accountId == null) return;
    if (tables.includes(TABLE_FAMILIES.CONTACTS)) {
      Promise.all([refreshAddressbooks(), refreshContacts()]).catch((err) => {
        console.warn('[contacts-store] contact refresh after broadcast failed', err);
      });
    }
    if (tables.includes(TABLE_FAMILIES.IDENTITIES)) {
      refreshIdentities().catch((err) => {
        console.warn('[contacts-store] identity refresh after broadcast failed', err);
      });
    }
  }

  async function refresh(): Promise<void> {
    await Promise.all([refreshAddressbooks(), refreshContacts(), refreshIdentities()]);
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
    const inserted = await repo.insertPendingMutation(mutation);
    const result = typeof repo.runMutation === 'function' && inserted?.id != null
      ? await repo.runMutation(authStore.accountId, inserted.id)
      : await repo.drainOutbox(authStore.accountId);
    return {
      ok: (result?.failed ?? 0) === 0
        && ((result?.attempted ?? 0) > 0 || (result?.succeeded ?? 0) > 0),
      ...(typeof result?.errorType === 'string' ? { errorType: result.errorType } : {}),
    };
  }

  async function queueAndRun(mutation: PendingMutationInsert): Promise<boolean> {
    return (await queueAndRunResult(mutation)).ok;
  }

  /**
   * Load a single contact plus its full email list for the edit form.
   */
  async function getContact(contactId: number): Promise<ContactDetail | null> {
    if (!repo || authStore.accountId == null) return null;
    return repo.getContact(authStore.accountId, contactId);
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
  async function createContact(
    input: { name?: string | null; emails: string[]; addressbookId?: number | null },
  ): Promise<boolean> {
    error.value = null;
    const name = input.name?.trim() || null;
    const { ok, list } = cleanEmailList(input.emails);
    if (!ok) {
      error.value = 'Enter a valid email address.';
      return false;
    }
    if (list.length === 0) {
      error.value = 'Enter at least one email address.';
      return false;
    }
    if (!repo || authStore.accountId == null) {
      error.value = 'Not connected.';
      return false;
    }
    const bookRemoteId = input.addressbookId == null
      ? null
      : (addressbooks.value.find((b) => b.id === input.addressbookId)?.remote_id ?? null);
    saving.value = true;
    try {
      const ok2 = await queueAndRun({
        accountId: authStore.accountId,
        mutationType: MUTATION_TYPE.CREATE_CONTACT,
        targetMessageId: null,
        requestJson: JSON.stringify({ emails: list, name, bookRemoteId }),
      });
      if (!ok2) {
        error.value = 'Could not add the contact. Please try again.';
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

  /**
   * Edit an existing contact's name and email list. `emails` is the full
   * desired ordered list; the outbox handler merges it against the
   * server card so untouched email metadata and other card fields are
   * preserved. Returns true on success.
   */
  async function updateContact(
    input: { remoteId: string | null; name?: string | null; emails: string[] },
  ): Promise<boolean> {
    error.value = null;
    const name = input.name?.trim() || null;
    const { ok, list } = cleanEmailList(input.emails);
    if (!ok) {
      error.value = 'Enter a valid email address.';
      return false;
    }
    if (list.length === 0) {
      error.value = 'Enter at least one email address.';
      return false;
    }
    if (!repo || authStore.accountId == null) {
      error.value = 'Not connected.';
      return false;
    }
    if (!input.remoteId) {
      error.value = 'This contact cannot be edited yet — try again in a moment.';
      return false;
    }
    saving.value = true;
    try {
      const ok2 = await queueAndRun({
        accountId: authStore.accountId,
        mutationType: MUTATION_TYPE.UPDATE_CONTACT,
        targetMessageId: null,
        requestJson: JSON.stringify({ remoteId: input.remoteId, emails: list, name }),
      });
      if (!ok2) {
        error.value = 'Could not save the contact. Please try again.';
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

  /**
   * Remove a contact. Optimistically drops the row from the list for
   * immediate feedback, queues a deleteContact mutation, and runs it;
   * the outbox handler destroys the server card and soft-deletes the
   * local row. On failure the list is refreshed to restore the row.
   */
  async function deleteContact(contact: ContactListRow): Promise<boolean> {
    error.value = null;
    if (!repo || authStore.accountId == null) {
      error.value = 'Not connected.';
      return false;
    }
    if (!contact.remote_id) {
      error.value = 'This contact cannot be removed yet — try again in a moment.';
      return false;
    }
    deletingIds.value = [...deletingIds.value, contact.id];
    const previous = contacts.value;
    contacts.value = previous.filter((c) => c.id !== contact.id);
    try {
      const ok2 = await queueAndRun({
        accountId: authStore.accountId,
        mutationType: MUTATION_TYPE.DELETE_CONTACT,
        targetMessageId: null,
        requestJson: JSON.stringify({ remoteId: contact.remote_id }),
      });
      if (!ok2) {
        error.value = 'Could not remove the contact. Please try again.';
        await refreshContacts();
        return false;
      }
      return true;
    } catch (err: any) {
      error.value = err?.message ?? String(err);
      await refreshContacts();
      return false;
    } finally {
      deletingIds.value = deletingIds.value.filter((id) => id !== contact.id);
    }
  }

  function identityErrorForMutation(errorType?: string): IdentityError {
    switch (errorType) {
      case IDENTITY_ERROR.ADDRESS_NOT_ALLOWED:
        return IDENTITY_ERROR.ADDRESS_NOT_ALLOWED;
      case IDENTITY_ERROR.INVALID_EMAIL:
        return IDENTITY_ERROR.INVALID_EMAIL;
      case 'invalidName':
        return IDENTITY_ERROR.INVALID_NAME;
      case 'notFound':
      case 'unknownIdentity':
        return IDENTITY_ERROR.NOT_FOUND;
      case 'accountNotFound':
      case 'accountNotSupportedByMethod':
      case 'accountReadOnly':
      case 'forbidden':
        return IDENTITY_ERROR.PERMISSION_DENIED;
      case 'cacheReconcileFailed':
        return IDENTITY_ERROR.CACHE_RECONCILIATION_FAILED;
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

  function identityFailure(code: IdentityError): IdentityActionResult {
    error.value = IDENTITY_ERROR_MESSAGE[code];
    return { ok: false, error: code };
  }

  async function createIdentity(
    input: { name?: string | null; email: string },
  ): Promise<IdentityActionResult> {
    error.value = null;
    const name = input.name?.trim() ?? '';
    const { ok, list } = cleanEmailList([input.email]);
    if (!name) {
      return identityFailure(IDENTITY_ERROR.NAME_REQUIRED);
    }
    if (!ok || list.length !== 1) {
      return identityFailure(IDENTITY_ERROR.INVALID_EMAIL);
    }
    if (!repo || authStore.accountId == null) {
      return identityFailure(IDENTITY_ERROR.NOT_CONNECTED);
    }
    saving.value = true;
    try {
      const result = await queueAndRunResult({
        accountId: authStore.accountId,
        mutationType: MUTATION_TYPE.CREATE_IDENTITY,
        targetMessageId: null,
        requestJson: JSON.stringify({ name, email: list[0] }),
      });
      if (!result.ok) {
        return identityFailure(identityErrorForMutation(result.errorType));
      }
      await refreshIdentities();
      return { ok: true };
    } catch {
      return identityFailure(IDENTITY_ERROR.SERVER_UNAVAILABLE);
    } finally {
      saving.value = false;
    }
  }

  async function updateIdentity(
    input: { remoteId: string; name?: string | null },
  ): Promise<IdentityActionResult> {
    error.value = null;
    const name = input.name?.trim() ?? '';
    if (!name) {
      return identityFailure(IDENTITY_ERROR.NAME_REQUIRED);
    }
    if (!repo || authStore.accountId == null) {
      return identityFailure(IDENTITY_ERROR.NOT_CONNECTED);
    }
    saving.value = true;
    try {
      const result = await queueAndRunResult({
        accountId: authStore.accountId,
        mutationType: MUTATION_TYPE.UPDATE_IDENTITY,
        targetMessageId: null,
        requestJson: JSON.stringify({
          remoteId: input.remoteId,
          name,
        }),
      });
      if (!result.ok) {
        return identityFailure(identityErrorForMutation(result.errorType));
      }
      await refreshIdentities();
      return { ok: true };
    } catch {
      return identityFailure(IDENTITY_ERROR.SERVER_UNAVAILABLE);
    } finally {
      saving.value = false;
    }
  }

  async function deleteIdentity(identity: IdentityRow): Promise<IdentityActionResult> {
    error.value = null;
    if (!repo || authStore.accountId == null) {
      return identityFailure(IDENTITY_ERROR.NOT_CONNECTED);
    }
    deletingIdentityIds.value = [...deletingIdentityIds.value, identity.id];
    const previous = identities.value;
    identities.value = previous.filter((entry) => entry.id !== identity.id);
    try {
      const result = await queueAndRunResult({
        accountId: authStore.accountId,
        mutationType: MUTATION_TYPE.DELETE_IDENTITY,
        targetMessageId: null,
        requestJson: JSON.stringify({ remoteId: identity.remote_id }),
      });
      if (!result.ok) {
        await refreshIdentities();
        return identityFailure(identityErrorForMutation(result.errorType));
      }
      return { ok: true };
    } catch {
      await refreshIdentities();
      return identityFailure(IDENTITY_ERROR.SERVER_UNAVAILABLE);
    } finally {
      deletingIdentityIds.value = deletingIdentityIds.value
        .filter((id) => id !== identity.id);
    }
  }

  return {
    addressbooks,
    contacts,
    identities,
    error,
    saving,
    deletingIds,
    deletingIdentityIds,
    $reset,
    attach,
    detach,
    refresh,
    refreshAddressbooks,
    refreshContacts,
    refreshIdentities,
    listContacts,
    listIdentities,
    getContact,
    autocomplete,
    createContact,
    updateContact,
    deleteContact,
    createIdentity,
    updateIdentity,
    deleteIdentity,
  };
});
