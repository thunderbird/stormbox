<script setup lang="ts">
import {
  computed, nextTick, onMounted, ref, watch,
} from 'vue';
import { storeToRefs } from 'pinia';
import { useVirtualizer } from '@tanstack/vue-virtual';
import {
  AtSign, BookUser, Pencil, Plus, Trash2, Users, X,
} from '@lucide/vue';

import { useContactsStore } from '../stores/contacts-store';
import type { AddressbookRow, ContactListRow, IdentityRow } from '../types';
import AppButton from './AppButton.vue';

const props = defineProps({
  filterQuery: { type: String, default: '' },
});

const contactsStore = useContactsStore();
const {
  contacts, identities, addressbooks, saving, deletingIds, deletingIdentityIds,
} = storeToRefs(contactsStore);

const showForm = ref(false);
const showingIdentities = ref(false);

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
const editingIdentity = ref<IdentityRow | null>(null);
// null = "All contacts"; otherwise a local addressbook id.
const selectedBookId = ref<number | null>(null);

onMounted(async () => {
  await contactsStore.attach();
  await contactsStore.listContacts();
});

/**
 * Per-book contact counts, derived from the loaded contact list. A card in
 * two books counts once in each, so these do not sum to the total.
 */
const bookCounts = computed(() => {
  const counts = new Map<number, number>();
  for (const c of contacts.value) {
    for (const bookId of c.addressbook_ids ?? []) {
      counts.set(bookId, (counts.get(bookId) ?? 0) + 1);
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

type DirectoryEntry =
  | {
    key: string;
    kind: 'contact';
    id: number;
    name: string;
    email: string;
    detail: string | null;
    contact: ContactListRow;
  }
  | {
    key: string;
    kind: 'identity';
    id: number;
    name: string;
    email: string;
    detail: string | null;
    identity: IdentityRow;
  };

function identityMayDelete(identity: IdentityRow): boolean {
  try {
    return JSON.parse(identity.raw_json ?? 'null')?.mayDelete === true;
  } catch {
    return false;
  }
}

function identityReplyTo(identity: IdentityRow): string | null {
  try {
    const [address] = JSON.parse(identity.reply_to_json ?? '[]');
    return typeof address?.email === 'string' && address.email
      ? `Reply-to: ${address.email}`
      : null;
  } catch {
    return null;
  }
}

const filtered = computed(() => {
  let list: DirectoryEntry[];
  if (showingIdentities.value) {
    list = identities.value.map((identity) => ({
      key: `identity:${identity.id}`,
      kind: 'identity',
      id: identity.id,
      name: identity.name || '(no name)',
      email: identity.email,
      detail: identityReplyTo(identity),
      identity,
    }));
  } else {
    let contactList = contacts.value;
    if (selectedBookId.value != null) {
      contactList = contactList.filter((contact) =>
        (contact.addressbook_ids ?? []).includes(selectedBookId.value!));
    }
    list = contactList.map((contact) => ({
      key: `contact:${contact.id}`,
      kind: 'contact',
      id: contact.id,
      name: contact.display_name || '(no name)',
      email: contact.email ?? '',
      detail: contact.organization,
      contact,
    }));
  }
  const term = props.filterQuery.trim().toLowerCase();
  if (term) {
    list = list.filter((entry) =>
      entry.name.toLowerCase().includes(term)
      || entry.email.toLowerCase().includes(term));
  }
  return list;
});

// The 30px action controls, 10px vertical padding, and 1px divider set
// the single-line row height used before measureElement observes it.
const CONTACT_ROW_ESTIMATE = 51;
const scrollEl = ref<HTMLElement | null>(null);
const virtualizer = useVirtualizer(
  computed(() => ({
    count: filtered.value.length,
    getScrollElement: () => scrollEl.value,
    estimateSize: () => CONTACT_ROW_ESTIMATE,
    overscan: 8,
    getItemKey: (index: number) => filtered.value[index]?.key ?? index,
  })),
);
const totalSize = computed(() => virtualizer.value.getTotalSize());
const renderedEntries = computed(() => virtualizer.value.getVirtualItems()
  .map((virtualRow) => ({ virtualRow, entry: filtered.value[virtualRow.index] }))
  .filter((rendered) => rendered.entry != null));
const measureElement = (el: Element | null) => {
  if (el) virtualizer.value.measureElement(el);
};

// Each filter and address-book result set starts from its first match.
watch(
  [() => props.filterQuery, selectedBookId, showingIdentities],
  async () => {
    await nextTick();
    if (scrollEl.value) virtualizer.value.scrollToOffset(0);
  },
);

// New contacts land in the selected book, or the default book when
// viewing "All contacts".
const addTargetLabel = computed(() => {
  if (selectedBook.value) return bookLabel(selectedBook.value);
  const fallback = addressbooks.value.find((b) => b.is_default) ?? addressbooks.value[0];
  return fallback ? bookLabel(fallback) : 'Contacts';
});

function selectBook(id: number | null) {
  if (showingIdentities.value) closeForm();
  showingIdentities.value = false;
  selectedBookId.value = id;
}

async function selectIdentities() {
  if (!showingIdentities.value) closeForm();
  showingIdentities.value = true;
  await contactsStore.listIdentities({ refreshServer: true });
}

const listTitle = computed(() => {
  if (showingIdentities.value) return 'Identities';
  return selectedBook.value ? bookLabel(selectedBook.value) : 'All contacts';
});

const addButtonLabel = computed(() =>
  showingIdentities.value ? 'Add identity' : 'Add contact');

const isEditing = computed(() =>
  editingContact.value !== null || editingIdentity.value !== null);

async function focusFormStart() {
  await nextTick();
  const selector = showingIdentities.value ? 'input[type="text"]' : 'input[type="email"]';
  formEl.value?.querySelector<HTMLInputElement>(selector)?.focus();
}

async function openAddForm() {
  editingContact.value = null;
  editingIdentity.value = null;
  newName.value = '';
  newEmails.value = [makeEmailRow()];
  showForm.value = true;
  await focusFormStart();
}

async function openEditForm(entry: DirectoryEntry) {
  if (entry.kind === 'identity') {
    editingContact.value = null;
    editingIdentity.value = entry.identity;
    newName.value = entry.identity.name ?? '';
    newEmails.value = [makeEmailRow(entry.identity.email)];
  } else {
    editingIdentity.value = null;
    editingContact.value = entry.contact;
    // Load the full email set (the list row only carries the primary one).
    const detail = await contactsStore.getContact(entry.contact.id);
    newName.value = detail?.full_name
      || detail?.display_name
      || entry.contact.display_name
      || '';
    const emails = (detail?.emails ?? []).map((email) => email.email).filter(Boolean);
    newEmails.value = emails.length > 0
      ? emails.map((email) => makeEmailRow(email))
      : [makeEmailRow(entry.contact.email ?? '')];
  }
  showForm.value = true;
  await focusFormStart();
}

function closeForm() {
  showForm.value = false;
  editingContact.value = null;
  editingIdentity.value = null;
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
  let ok: boolean;
  if (showingIdentities.value) {
    const result = editingIdentity.value
      ? await contactsStore.updateIdentity({
        remoteId: editingIdentity.value.remote_id,
        name: newName.value,
      })
      : await contactsStore.createIdentity({
        name: newName.value,
        email: emails[0] ?? '',
      });
    ok = result.ok;
  } else {
    ok = editingContact.value
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
  }
  if (ok) closeForm();
}

function isDeleting(entry: DirectoryEntry): boolean {
  return entry.kind === 'contact'
    ? deletingIds.value.includes(entry.id)
    : deletingIdentityIds.value.includes(entry.id);
}

function canRemove(entry: DirectoryEntry): boolean {
  return entry.kind === 'contact' || identityMayDelete(entry.identity);
}

async function removeEntry(entry: DirectoryEntry) {
  if (entry.kind === 'contact') {
    await contactsStore.deleteContact(entry.contact);
    return;
  }
  if (identityMayDelete(entry.identity)) {
    await contactsStore.deleteIdentity(entry.identity);
  }
}
</script>

<template>
  <section class="contacts">
    <nav class="contacts__rail" aria-label="Address books">
      <button
        class="contacts__book"
        type="button"
        :class="{ 'contacts__book--active': !showingIdentities && selectedBookId === null }"
        :aria-pressed="!showingIdentities && selectedBookId === null"
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
        :class="{ 'contacts__book--active': !showingIdentities && selectedBookId === book.id }"
        :aria-pressed="!showingIdentities && selectedBookId === book.id"
        @click="selectBook(book.id)"
      >
        <BookUser :size="16" :stroke-width="1.75" aria-hidden="true" />
        <span class="contacts__book-name">{{ bookLabel(book) }}</span>
        <span class="contacts__book-count">{{ bookCounts.get(book.id) ?? 0 }}</span>
      </button>

      <div class="contacts__identity-section">
        <button
          class="contacts__book"
          type="button"
          :class="{ 'contacts__book--active': showingIdentities }"
          :aria-pressed="showingIdentities"
          @click="selectIdentities"
        >
          <AtSign :size="16" :stroke-width="1.75" aria-hidden="true" />
          <span class="contacts__book-name">Manage identities</span>
          <span class="contacts__book-count">{{ identities.length }}</span>
        </button>
      </div>
    </nav>

    <div class="contacts__main">
      <header class="contacts__header">
        <h2>{{ listTitle }}</h2>
        <div class="contacts__header-actions">
          <AppButton class="contacts__add" @click="openAddForm">
            <template #iconLeft>
              <Plus :size="16" :stroke-width="2" aria-hidden="true" />
            </template>
            {{ addButtonLabel }}
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
            :placeholder="showingIdentities ? 'Display name' : 'Optional'"
            autocomplete="off"
            :required="showingIdentities"
          />
        </label>

        <div class="contacts__field">
          <span class="contacts__field-label">
            {{ showingIdentities && editingIdentity ? 'Email (cannot be changed)' : 'Email' }}
          </span>
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
              :disabled="showingIdentities && editingIdentity !== null"
            />
            <button
              v-if="!showingIdentities && newEmails.length > 1"
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
            v-if="!showingIdentities"
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
            {{
              isEditing
                ? `Editing ${showingIdentities ? 'identity' : 'contact'}`
                : (showingIdentities ? 'Adding identity' : `Adding to ${addTargetLabel}`)
            }}
          </span>
          <div class="contacts__form-actions">
            <AppButton variant="outline" :disabled="saving" @click="closeForm">
              Cancel
            </AppButton>
            <AppButton form-action="submit" :disabled="saving">
              {{
                saving
                  ? 'Saving…'
                  : (isEditing
                    ? 'Save changes'
                    : `Save ${showingIdentities ? 'identity' : 'contact'}`)
              }}
            </AppButton>
          </div>
        </div>
      </form>

      <div
        v-if="filtered.length > 0"
        ref="scrollEl"
        class="contacts__list"
        role="list"
      >
        <div
          class="contacts__list-spacer"
          role="presentation"
          :style="{ height: `${totalSize}px` }"
        >
          <div
            v-for="{ virtualRow, entry } in renderedEntries"
            :key="String(virtualRow.key)"
            :ref="measureElement"
            :data-index="virtualRow.index"
            class="contacts__row"
            role="listitem"
            :aria-posinset="virtualRow.index + 1"
            :aria-setsize="filtered.length"
            :style="{ transform: `translateY(${virtualRow.start}px)` }"
          >
            <span class="name">{{ entry.name }}</span>
            <span class="email">{{ entry.email }}</span>
            <span v-if="entry.detail" class="org">{{ entry.detail }}</span>
            <span v-else class="org" aria-hidden="true" />
            <div class="contacts__row-actions">
              <button
                class="contacts__row-action"
                type="button"
                :disabled="isDeleting(entry)"
                :title="`Edit ${entry.name || entry.email}`"
                :aria-label="`Edit ${entry.name || entry.email}`"
                @click="openEditForm(entry)"
              >
                <Pencil :size="16" :stroke-width="1.75" aria-hidden="true" />
              </button>
              <button
                class="contacts__row-action contacts__row-action--danger"
                type="button"
                :disabled="isDeleting(entry) || !canRemove(entry)"
                :title="canRemove(entry)
                  ? `Remove ${entry.name || entry.email}`
                  : 'This identity cannot be removed'"
                :aria-label="canRemove(entry)
                  ? `Remove ${entry.name || entry.email}`
                  : `${entry.name || entry.email} cannot be removed`"
                @click="removeEntry(entry)"
              >
                <Trash2 :size="16" :stroke-width="1.75" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      </div>
      <p v-else class="contacts__empty">
        {{
          showingIdentities
            ? (identities.length === 0 ? 'No identities yet.' : 'No matches.')
            : (contacts.length === 0 ? 'No contacts yet.' : 'No matches.')
        }}
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
.contacts__identity-section {
  margin-top: auto;
  padding-top: 8px;
  border-top: 1px solid var(--border-soft, #eef0f5);
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
.contacts__list {
  margin: 0;
  padding: 0;
  overflow-y: auto;
  flex: 1 1 auto;
  min-height: 0;
}
.contacts__list-spacer {
  position: relative;
  width: 100%;
}
.contacts__row {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
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
  .contacts__identity-section {
    flex: 0 0 auto;
    margin-top: 0;
    padding-top: 0;
    border-top: 0;
  }
}

@media (max-width: 560px) {
  .contacts__header { flex-direction: column; align-items: stretch; }
  .contacts__header-actions { justify-content: space-between; }
  .contacts__row-action { opacity: 1; }
}
</style>
