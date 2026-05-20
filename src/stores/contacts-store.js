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

import { getRepositoryAsync } from '../composables/use-repository.js';
import { useAuthStore } from './auth-store.js';
import { TABLE_FAMILIES } from '../db/protocol.js';

export const useContactsStore = defineStore('contacts', () => {
  const authStore = useAuthStore();
  const addressbooks = ref([]);
  const contacts = ref([]);
  const error = ref(null);
  let repo = null;
  let unsubscribe = null;

  async function attach() {
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
        addressbooks.value = [];
        contacts.value = [];
      },
      { immediate: true },
    );
  }

  function detach() {
    unsubscribe?.();
    unsubscribe = null;
    repo = null;
  }

  function onTablesTouched(tables) {
    if (!tables.includes(TABLE_FAMILIES.CONTACTS)) return;
    if (authStore.accountId == null) return;
    refresh().catch((err) => {
      console.warn('[contacts-store] refresh after broadcast failed', err);
    });
  }

  async function refresh() {
    await Promise.all([refreshAddressbooks(), refreshContacts()]);
  }

  async function refreshAddressbooks() {
    if (!repo || authStore.accountId == null) {
      addressbooks.value = [];
      return;
    }
    try {
      addressbooks.value = await repo.listAddressbooks(authStore.accountId);
    } catch (err) {
      error.value = err?.message ?? String(err);
    }
  }

  async function refreshContacts(options = {}) {
    if (!repo || authStore.accountId == null) {
      contacts.value = [];
      return;
    }
    try {
      contacts.value = await repo.listContacts(authStore.accountId, options);
    } catch (err) {
      error.value = err?.message ?? String(err);
    }
  }

  /**
   * Read-through accessor so callers that just want the current list
   * can `await store.listContacts()` without depending on the watch
   * having already fired. Returns the same array bound to `contacts`.
   */
  async function listContacts(options = {}) {
    await refreshContacts(options);
    return contacts.value;
  }

  /**
   * Resolve a typeahead prefix into a list of {name, email, source}
   * candidates. `source` is 'contact' or 'history'.
   */
  async function autocomplete(prefix, limit = 20) {
    if (!repo || authStore.accountId == null || !prefix) {
      return [];
    }
    return repo.autocompleteContacts(authStore.accountId, prefix, limit);
  }

  return {
    addressbooks,
    contacts,
    error,
    attach,
    detach,
    refresh,
    refreshAddressbooks,
    refreshContacts,
    listContacts,
    autocomplete,
  };
});
