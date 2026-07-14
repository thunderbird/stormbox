<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { BookUser, Pencil, Plus, Trash2, Users, X } from '@lucide/vue';

import { useContactsStore } from '../stores/contacts-store';
import type { AddressbookRow, ContactListRow } from '../types';
import AppButton from './AppButton.vue';

const contactsStore = useContactsStore();
const { contacts, addressbooks, saving, deletingIds } = storeToRefs(contactsStore);

const filter = ref('');
const showForm = ref(false);
const newName = ref('');
// One entry per email input row; always at least one row. Each row
// carries a stable id so v-for keys stay attached to the same input
// when a middle row is removed (index keys would shift and reuse the
// wrong input/focus state).
interface EmailRow { id: number; value: string; }
let emailRowSeq = 0;
function makeEmailRow(value = ''): EmailRow {
  emailRowSeq += 1;
  return { id: emailRowSeq, value };
}
const newEmails = ref<EmailRow[]>([makeEmailRow()]);
const formEl = ref<HTMLFormElement | null>(null);
// When set, the form edits this contact instead of creating a new one.
const editingContact = ref<ContactListRow | null>(null);
// null = "All contacts"; otherwise a local addressbook id.
const selectedBookId = ref<number | null>(null);

onMounted(async () => {
  await contactsStore.attach();
  await contactsStore.listContacts();
});

/** Per-book contact counts, derived from the loaded contact list. */
const bookCounts = computed(() => {
  const counts = new Map<number, number>();
  for (const c of contacts.value) {
    if (c.addressbook_id != null) {
      counts.set(c.addressbook_id, (counts.get(c.addressbook_id) ?? 0) + 1);
    }
  }
  return counts;
});

/** The default book's ugly server name reads as an implementation
 *  detail, so present it as "Personal". */
function bookLabel(book: AddressbookRow): string {
  if (book.is_default) return 'Personal';
  return book.name || 'Address book';
}

const selectedBook = computed(() =>
  addressbooks.value.find((b) => b.id === selectedBookId.value) ?? null);

const filtered = computed(() => {
  let list = contacts.value;
  if (selectedBookId.value != null) {
    list = list.filter((c) => c.addressbook_id === selectedBookId.value);
  }
  const term = filter.value.trim().toLowerCase();
  if (term) {
    list = list.filter((c) =>
      (c.display_name ?? '').toLowerCase().includes(term)
      || (c.email ?? '').toLowerCase().includes(term));
  }
  return list;
});

// New contacts land in the selected book, or the default book when
// viewing "All contacts".
const addTargetLabel = computed(() => {
  if (selectedBook.value) return bookLabel(selectedBook.value);
  const fallback = addressbooks.value.find((b) => b.is_default) ?? addressbooks.value[0];
  return fallback ? bookLabel(fallback) : 'Contacts';
});

function selectBook(id: number | null) {
  selectedBookId.value = id;
}

const isEditing = computed(() => editingContact.value !== null);

async function focusFirstEmail() {
  await nextTick();
  formEl.value?.querySelector<HTMLInputElement>('input[type="email"]')?.focus();
}

async function openAddForm() {
  editingContact.value = null;
  newName.value = '';
  newEmails.value = [makeEmailRow()];
  showForm.value = true;
  await focusFirstEmail();
}

async function openEditForm(contact: ContactListRow) {
  editingContact.value = contact;
  // Load the full email set (the list row only carries the primary one).
  const detail = await contactsStore.getContact(contact.id);
  newName.value = detail?.full_name || detail?.display_name || contact.display_name || '';
  const emails = (detail?.emails ?? []).map((e) => e.email).filter(Boolean);
  newEmails.value = emails.length > 0
    ? emails.map((e) => makeEmailRow(e))
    : [makeEmailRow(contact.email ?? '')];
  showForm.value = true;
  await focusFirstEmail();
}

function closeForm() {
  showForm.value = false;
  editingContact.value = null;
  newName.value = '';
  newEmails.value = [makeEmailRow()];
}

function addEmailRow() {
  newEmails.value = [...newEmails.value, makeEmailRow()];
}

function removeEmailRow(index: number) {
  if (newEmails.value.length <= 1) {
    newEmails.value = [makeEmailRow()];
    return;
  }
  newEmails.value = newEmails.value.filter((_, i) => i !== index);
}

async function submitForm() {
  const emails = newEmails.value.map((row) => row.value);
  const ok = editingContact.value
    ? await contactsStore.updateContact({
      remoteId: editingContact.value.remote_id,
      name: newName.value,
      emails,
    })
    : await contactsStore.createContact({
      name: newName.value,
      emails,
      addressbookId: selectedBookId.value,
    });
  if (ok) closeForm();
}

function isDeleting(contact: ContactListRow): boolean {
  return deletingIds.value.includes(contact.id);
}

async function removeContact(contact: ContactListRow) {
  await contactsStore.deleteContact(contact);
}
</script>

<template>
  <section class="contacts">
    <nav class="contacts__rail" aria-label="Address books">
      <button
        class="contacts__book"
        type="button"
        :class="{ 'contacts__book--active': selectedBookId === null }"
        :aria-pressed="selectedBookId === null"
        @click="selectBook(null)"
      >
        <Users :size="16" :stroke-width="1.75" aria-hidden="true" />
        <span class="contacts__book-name">All contacts</span>
        <span class="contacts__book-count">{{ contacts.length }}</span>
      </button>

      <button
        v-for="book in addressbooks"
        :key="book.id"
        class="contacts__book"
        type="button"
        :class="{ 'contacts__book--active': selectedBookId === book.id }"
        :aria-pressed="selectedBookId === book.id"
        @click="selectBook(book.id)"
      >
        <BookUser :size="16" :stroke-width="1.75" aria-hidden="true" />
        <span class="contacts__book-name">{{ bookLabel(book) }}</span>
        <span class="contacts__book-count">{{ bookCounts.get(book.id) ?? 0 }}</span>
      </button>
    </nav>

    <div class="contacts__main">
      <header class="contacts__header">
        <h2>{{ selectedBook ? bookLabel(selectedBook) : 'All contacts' }}</h2>
        <div class="contacts__header-actions">
          <input
            type="search"
            v-model="filter"
            placeholder="Filter…"
            class="contacts__filter"
            aria-label="Filter contacts"
          />
          <AppButton class="contacts__add" @click="openAddForm">
            <template #iconLeft>
              <Plus :size="16" :stroke-width="2" aria-hidden="true" />
            </template>
            Add contact
          </AppButton>
        </div>
      </header>

      <form
        v-if="showForm"
        ref="formEl"
        class="contacts__form"
        @submit.prevent="submitForm"
      >
        <label class="contacts__field">
          <span class="contacts__field-label">Name</span>
          <input
            v-model="newName"
            type="text"
            class="contacts__input"
            placeholder="Optional"
            autocomplete="off"
          />
        </label>

        <div class="contacts__field">
          <span class="contacts__field-label">Email</span>
          <div
            v-for="(row, index) in newEmails"
            :key="row.id"
            class="contacts__email-row"
          >
            <input
              v-model="row.value"
              type="email"
              class="contacts__input"
              placeholder="name@example.com"
              autocomplete="off"
              :required="index === 0"
            />
            <button
              v-if="newEmails.length > 1"
              class="contacts__email-remove"
              type="button"
              :aria-label="`Remove email ${index + 1}`"
              title="Remove email"
              @click="removeEmailRow(index)"
            >
              <X :size="15" :stroke-width="2" aria-hidden="true" />
            </button>
          </div>
          <button
            class="contacts__email-add"
            type="button"
            @click="addEmailRow"
          >
            <Plus :size="14" :stroke-width="2" aria-hidden="true" />
            <span>Add another email</span>
          </button>
        </div>

        <div class="contacts__form-footer">
          <span class="contacts__form-hint">
            {{ isEditing ? 'Editing contact' : `Adding to ${addTargetLabel}` }}
          </span>
          <div class="contacts__form-actions">
            <AppButton variant="outline" :disabled="saving" @click="closeForm">
              Cancel
            </AppButton>
            <AppButton form-action="submit" :disabled="saving">
              {{ saving ? 'Saving…' : (isEditing ? 'Save changes' : 'Save contact') }}
            </AppButton>
          </div>
        </div>
      </form>

      <ul v-if="filtered.length > 0" class="contacts__list">
        <li v-for="c in filtered" :key="c.id" class="contacts__row">
          <span class="name">{{ c.display_name || '(no name)' }}</span>
          <span class="email">{{ c.email }}</span>
          <span v-if="c.organization" class="org">{{ c.organization }}</span>
          <span v-else class="org" aria-hidden="true" />
          <div class="contacts__row-actions">
            <button
              class="contacts__row-action"
              type="button"
              :disabled="isDeleting(c)"
              :title="`Edit ${c.display_name || c.email || 'contact'}`"
              :aria-label="`Edit ${c.display_name || c.email || 'contact'}`"
              @click="openEditForm(c)"
            >
              <Pencil :size="16" :stroke-width="1.75" aria-hidden="true" />
            </button>
            <button
              class="contacts__row-action contacts__row-action--danger"
              type="button"
              :disabled="isDeleting(c)"
              :title="`Remove ${c.display_name || c.email || 'contact'}`"
              :aria-label="`Remove ${c.display_name || c.email || 'contact'}`"
              @click="removeContact(c)"
            >
              <Trash2 :size="16" :stroke-width="1.75" aria-hidden="true" />
            </button>
          </div>
        </li>
      </ul>
      <p v-else class="contacts__empty">
        {{ contacts.length === 0 ? 'No contacts yet.' : 'No matches.' }}
      </p>
    </div>
  </section>
</template>

<style scoped>
.contacts {
  display: grid;
  grid-template-columns: minmax(180px, 240px) minmax(0, 1fr);
  /* Without a constrained row, the rail and main column grow to their
     content and the shell (overflow: hidden) clips everything below
     the first viewport — the list becomes unscrollable. */
  grid-template-rows: minmax(0, 1fr);
  min-width: 0;
  min-height: 0;
  background: var(--surface, #fff);
}

/* Address-book rail — mirrors the mail folder list's role and spacing. */
.contacts__rail {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px 8px;
  border-right: 1px solid var(--border, #e3e6ee);
  overflow-y: auto;
}
.contacts__book {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text, #1a1d24);
  font: inherit;
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
.contacts__book:hover { background: var(--rowHover, #f0f1f6); }
.contacts__book--active {
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--text, #1a1d24);
  font-weight: 600;
}
.contacts__book--active > svg { color: var(--accent); }
.contacts__book-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.contacts__book-count {
  flex-shrink: 0;
  min-width: 20px;
  padding: 1px 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--muted) 18%, transparent);
  color: var(--muted, #6b7388);
  font-size: 12px;
  font-weight: 600;
  text-align: center;
}
.contacts__book--active .contacts__book-count {
  background: color-mix(in srgb, var(--accent) 26%, transparent);
  color: var(--text, #1a1d24);
}

.contacts__main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.contacts__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px;
  border-bottom: 1px solid var(--border, #e3e6ee);
}
.contacts h2 {
  margin: 0;
  font-size: 16px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.contacts__header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.contacts__filter {
  padding: 6px 10px;
  border: 1px solid var(--border, #d6d9e2);
  border-radius: 8px;
  font: inherit;
  font-size: 13px;
  width: 220px;
  background: var(--panel, #fff);
  color: var(--text, #1a1d24);
}
.contacts__filter:focus-visible {
  outline: none;
  border-color: color-mix(in srgb, var(--accent) 60%, var(--border));
}

/* Add contact is an AppButton; only keep it from wrapping. */
.contacts__add {
  white-space: nowrap;
  flex: none;
}

.contacts__form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border, #e3e6ee);
  background: color-mix(in srgb, var(--panel2, #f5f6fa) 60%, transparent);
}
.contacts__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.contacts__field-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--muted, #6b7388);
}
.contacts__input {
  flex: 1 1 auto;
  padding: 7px 10px;
  border: 1px solid var(--border, #d6d9e2);
  border-radius: 8px;
  font: inherit;
  font-size: 14px;
  background: var(--panel, #fff);
  color: var(--text, #1a1d24);
  min-width: 0;
}
.contacts__input:focus-visible {
  outline: none;
  border-color: color-mix(in srgb, var(--accent) 60%, var(--border));
}
.contacts__email-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.contacts__email-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--muted, #6b7388);
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
.contacts__email-remove:hover { background: rgba(255, 107, 107, 0.12); color: #ff6b6b; }
.contacts__email-add {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 2px;
  padding: 4px 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--accent);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.contacts__email-add:hover { text-decoration: underline; }
.contacts__form-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.contacts__form-hint {
  font-size: 12px;
  color: var(--muted, #6b7388);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.contacts__form-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.contacts__list { list-style: none; margin: 0; padding: 0; overflow-y: auto; flex: 1 1 auto; min-height: 0; }
.contacts__row {
  display: grid;
  grid-template-columns: 1.6fr 2fr 1fr auto;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border-soft, #eef0f5);
  font-size: 14px;
  align-items: center;
}
.contacts__row:hover { background: var(--rowHover, #f0f1f6); }
.name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.email { color: var(--muted, #6b7388); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.org { color: var(--muted, #6b7388); font-size: 12px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Ghost icon buttons, revealed on row hover/focus — mirrors the
   message-list/message-view action buttons. */
.contacts__row-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.contacts__row-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--muted, #6b7388);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s ease, background 0.12s ease, color 0.12s ease;
}
.contacts__row:hover .contacts__row-action,
.contacts__row-action:focus-visible { opacity: 1; }
.contacts__row-action:hover { background: var(--rowHover, #f0f1f6); color: var(--text, #1a1d24); }
.contacts__row-action--danger:hover { background: rgba(255, 107, 107, 0.12); color: #ff6b6b; }
.contacts__row-action:disabled { opacity: 0.4; cursor: default; }

.contacts__empty { padding: 24px; color: var(--muted, #6b7388); }

@media (max-width: 720px) {
  .contacts {
    grid-template-columns: 1fr;
    grid-template-rows: auto minmax(0, 1fr);
  }
  /* Rail collapses to a horizontal, scrollable chip row above the list. */
  .contacts__rail {
    flex-direction: row;
    gap: 6px;
    padding: 10px 12px;
    border-right: 0;
    border-bottom: 1px solid var(--border, #e3e6ee);
    overflow-x: auto;
  }
  .contacts__book {
    width: auto;
    flex: 0 0 auto;
    border: 1px solid var(--border, #d6d9e2);
    border-radius: 999px;
  }
}

@media (max-width: 560px) {
  .contacts__header { flex-direction: column; align-items: stretch; }
  .contacts__header-actions { justify-content: space-between; }
  .contacts__filter { width: auto; flex: 1 1 auto; }
  .contacts__row-action { opacity: 1; }
}
</style>
