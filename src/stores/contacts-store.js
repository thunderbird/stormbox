/**
 * Contacts store. Exists primarily to back recipient autocomplete in
 * compose; the contact list view itself reads via repository queries
 * directly. Read-only for MVP.
 */

import { defineStore } from 'pinia';
import { ref, watch } from 'vue';

import { getRepositoryAsync } from '../composables/use-repository.js';
import { useAuthStore } from './auth-store.js';

export const useContactsStore = defineStore('contacts', () => {
  const authStore = useAuthStore();
  const addressbooks = ref([]);
  const error = ref(null);
  let repo = null;

  async function attach() {
    if (repo) return;
    repo = await getRepositoryAsync();
    watch(
      () => authStore.accountId,
      async (newId) => {
        if (newId) {
          await refreshAddressbooks();
        } else {
          addressbooks.value = [];
        }
      },
      { immediate: true },
    );
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

  /**
   * Resolve a typeahead prefix into a list of {name, email, source}
   * candidates. Source is 'contact' or 'history'.
   */
  async function autocomplete(prefix, limit = 20) {
    if (!repo || authStore.accountId == null || !prefix) {
      return [];
    }
    return repo.autocompleteContacts(authStore.accountId, prefix, limit);
  }

  return {
    addressbooks,
    error,
    attach,
    refreshAddressbooks,
    autocomplete,
  };
});
