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
import { MUTATION_TYPE } from '../constants/states';
import { TABLE_FAMILIES } from '../db/protocol';
import type { AddressbookRow, ContactListRow } from '../types';
import type { Repository } from '../db/repository';

export interface AutocompleteCandidate {
  name?: string | null;
  email: string;
  source: 'contact' | 'history';
  is_preferred?: 0 | 1;
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
    const lower = addr.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
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
  addressbook_id: number | null;
  display_name: string | null;
  full_name: string | null;
  organization: string | null;
  emails: ContactDetailEmail[];
}

export const useContactsStore = defineStore('contacts', () => {
  const authStore = useAuthStore();
  const addressbooks = ref<AddressbookRow[]>([]);
  const contacts = ref<ContactListRow[]>([]);
  const error = ref<string | null>(null);
  const saving = ref(false);
  const deletingIds = ref<number[]>([]);
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
    error.value = null;
    saving.value = false;
    deletingIds.value = [];
  }

  function onTablesTouched(tables: string[]): void {
    if (!tables.includes(TABLE_FAMILIES.CONTACTS)) return;
    if (authStore.accountId == null) return;
    refresh().catch((err) => {
      console.warn('[contacts-store] refresh after broadcast failed', err);
    });
  }

  async function refresh(): Promise<void> {
    await Promise.all([refreshAddressbooks(), refreshContacts()]);
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

  /**
   * Read-through accessor so callers that just want the current list
   * can `await store.listContacts()` without depending on the watch
   * having already fired. Returns the same array bound to `contacts`.
   */
  async function listContacts(options: { limit?: number } = {}): Promise<ContactListRow[]> {
    await refreshContacts(options);
    return contacts.value;
  }

  /**
   * Resolve a typeahead prefix into a list of {name, email, source}
   * candidates. `source` is 'contact' or 'history'.
   */
  async function autocomplete(prefix: string, limit = 20): Promise<AutocompleteCandidate[]> {
    if (!repo || authStore.accountId == null || !prefix) {
      return [];
    }
    return repo.autocompleteContacts(authStore.accountId, prefix, limit);
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
      const mutation = await repo.insertPendingMutation({
        accountId: authStore.accountId,
        mutationType: MUTATION_TYPE.CREATE_CONTACT,
        targetMessageId: null,
        requestJson: JSON.stringify({ emails: list, name, bookRemoteId }),
      });
      const result = typeof repo.runMutation === 'function' && mutation?.id != null
        ? await repo.runMutation(authStore.accountId, mutation.id)
        : await repo.drainOutbox(authStore.accountId);
      if (result.failed > 0) {
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
      const mutation = await repo.insertPendingMutation({
        accountId: authStore.accountId,
        mutationType: MUTATION_TYPE.UPDATE_CONTACT,
        targetMessageId: null,
        requestJson: JSON.stringify({ remoteId: input.remoteId, emails: list, name }),
      });
      const result = typeof repo.runMutation === 'function' && mutation?.id != null
        ? await repo.runMutation(authStore.accountId, mutation.id)
        : await repo.drainOutbox(authStore.accountId);
      if (result.failed > 0) {
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
      const mutation = await repo.insertPendingMutation({
        accountId: authStore.accountId,
        mutationType: MUTATION_TYPE.DELETE_CONTACT,
        targetMessageId: null,
        requestJson: JSON.stringify({ remoteId: contact.remote_id }),
      });
      const result = typeof repo.runMutation === 'function' && mutation?.id != null
        ? await repo.runMutation(authStore.accountId, mutation.id)
        : await repo.drainOutbox(authStore.accountId);
      if (result.failed > 0) {
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

  return {
    addressbooks,
    contacts,
    error,
    saving,
    deletingIds,
    $reset,
    attach,
    detach,
    refresh,
    refreshAddressbooks,
    refreshContacts,
    listContacts,
    getContact,
    autocomplete,
    createContact,
    updateContact,
    deleteContact,
  };
});
