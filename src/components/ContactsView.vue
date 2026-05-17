<script setup>
import { computed, onMounted, ref } from 'vue';

import { useAuthStore } from '../stores/auth-store.js';
import { useContactsStore } from '../stores/contacts-store.js';
import { getRepositoryAsync } from '../composables/use-repository.js';

const authStore = useAuthStore();
const contactsStore = useContactsStore();

const contacts = ref([]);
const filter = ref('');

onMounted(async () => {
  await contactsStore.attach();
  await refresh();
});

async function refresh() {
  if (!authStore.accountId) return;
  const repo = await getRepositoryAsync();
  contacts.value = await repo.call('db.query', {
    sql: `SELECT c.id, c.display_name, c.organization,
                 (SELECT email FROM contact_emails ce WHERE ce.contact_id = c.id ORDER BY is_preferred DESC, position LIMIT 1) AS email
          FROM contacts c
          WHERE c.account_id = ? AND c.is_deleted = 0
          ORDER BY c.display_name COLLATE NOCASE
          LIMIT 500`,
    params: [authStore.accountId],
  });
}

const filtered = computed(() => {
  const term = filter.value.trim().toLowerCase();
  if (!term) return contacts.value;
  return contacts.value.filter((c) =>
    (c.display_name ?? '').toLowerCase().includes(term)
    || (c.email ?? '').toLowerCase().includes(term),
  );
});
</script>

<template>
  <section class="contacts">
    <header>
      <h2>Contacts</h2>
      <input
        type="search"
        v-model="filter"
        placeholder="Filter…"
        class="contacts__filter"
      />
    </header>
    <ul v-if="filtered.length > 0" class="contacts__list">
      <li v-for="c in filtered" :key="c.id">
        <span class="name">{{ c.display_name || '(no name)' }}</span>
        <span class="email">{{ c.email }}</span>
        <span v-if="c.organization" class="org">{{ c.organization }}</span>
      </li>
    </ul>
    <p v-else class="contacts__empty">
      {{ contacts.length === 0 ? 'No contacts yet.' : 'No matches.' }}
    </p>
  </section>
</template>

<style scoped>
.contacts {
  display: flex;
  flex-direction: column;
  background: var(--surface, #fff);
  min-width: 0;
}
.contacts header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid var(--border, #e3e6ee);
}
.contacts h2 { margin: 0; font-size: 16px; }
.contacts__filter {
  padding: 6px 10px;
  border: 1px solid var(--border, #d6d9e2);
  border-radius: 8px;
  font-size: 13px;
  width: 220px;
}
.contacts__list { list-style: none; margin: 0; padding: 0; overflow-y: auto; }
.contacts__list li {
  display: grid;
  grid-template-columns: 1.6fr 2fr 1fr;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border-soft, #eef0f5);
  font-size: 14px;
  align-items: baseline;
}
.email { color: var(--muted, #6b7388); }
.org { color: var(--muted, #6b7388); font-size: 12px; }
.contacts__empty { padding: 24px; color: var(--muted, #6b7388); }
</style>
