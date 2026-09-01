<script setup lang="ts">
import {
  AtSign,
  BookUser,
  ContactRound,
  Plus,
  Trash2,
  Users,
} from '@lucide/vue';
import { ref } from 'vue';

import { useContactDragDrop } from '../../composables/useContactDragDrop';
import type { AddressbookRow } from '../../types';
import { isTrustedSendersBook } from '../../utils/address-book-policy';
import AppButton from '../AppButton.vue';
import {
  addressBookDisplayName,
  type DirectoryKind,
} from './directory-types';

const props = defineProps<{
  addressbooks: AddressbookRow[];
  bookCounts: Map<number, number>;
  canCreateAddressBook: boolean;
  contactCount: number;
  identityCount: number;
  trashCount: number;
  kind: DirectoryKind;
  selectedBookId: number | null;
}>();

const emit = defineEmits<{
  moveContacts: [payload: {
    contactIds: number[];
    sourceAddressbookId: number;
    targetAddressbookId: number;
  }];
  addContact: [];
  createAddressBook: [];
  selectBook: [id: number | null];
  selectIdentities: [];
  selectTrash: [];
}>();

const hoveredDropTarget = ref<number | null>(null);
const dropAnnouncement = ref('');
const {
  endContactDrag,
  readContactDrop,
  setContactDropEffect,
} = useContactDragDrop();

function canMoveTo(book: AddressbookRow, event?: DragEvent): boolean {
  if (props.kind !== 'contacts' || book.may_write !== 1) {
    return false;
  }
  const payload = readContactDrop(event);
  if (!payload?.ids.length || payload.sourceAddressbookId == null) return false;
  const source = props.addressbooks.find(
    (candidate) => candidate.id === payload.sourceAddressbookId,
  );
  return Boolean(
    source
    && source.may_write === 1
    && source.id !== book.id,
  );
}

function onBookDragOver(book: AddressbookRow, event: DragEvent): void {
  const allowed = canMoveTo(book, event);
  setContactDropEffect(event, allowed ? 'move' : null);
  hoveredDropTarget.value = allowed ? book.id : null;
  if (allowed) {
    dropAnnouncement.value = `Move contacts to ${addressBookDisplayName(book)}`;
  }
}

function onBookDragLeave(book: AddressbookRow, event: DragEvent): void {
  const next = event.relatedTarget;
  if (
    next instanceof Node
    && event.currentTarget instanceof Node
    && event.currentTarget.contains(next)
  ) {
    return;
  }
  if (hoveredDropTarget.value === book.id) hoveredDropTarget.value = null;
}

function onBookDrop(book: AddressbookRow, event: DragEvent): void {
  const payload = readContactDrop(event);
  const allowed = canMoveTo(book, event);
  hoveredDropTarget.value = null;
  endContactDrag();
  if (!allowed || !payload || payload.sourceAddressbookId == null) {
    dropAnnouncement.value = 'This address book cannot accept those contacts';
    return;
  }
  dropAnnouncement.value = `Moving ${payload.ids.length} contact${
    payload.ids.length === 1 ? '' : 's'
  } to ${addressBookDisplayName(book)}`;
  emit('moveContacts', {
    contactIds: payload.ids,
    sourceAddressbookId: payload.sourceAddressbookId,
    targetAddressbookId: book.id,
  });
}

function onInvalidDragOver(event: DragEvent): void {
  setContactDropEffect(event, null);
  hoveredDropTarget.value = null;
}

function onInvalidDrop(event: DragEvent): void {
  if (!readContactDrop(event)) return;
  hoveredDropTarget.value = null;
  dropAnnouncement.value = 'Choose a different writable address book';
  endContactDrag();
}
</script>

<template>
  <nav class="contacts-rail" aria-label="Address books">
    <header class="contacts-rail__header">
      <AppButton
        class="contacts-rail__create-book"
        :disabled="!canCreateAddressBook"
        title="Create address book"
        aria-label="Create address book"
        @click="emit('createAddressBook')"
      >
        <span class="contacts-rail__create-book-icon" aria-hidden="true">
          <BookUser :size="18" :stroke-width="1.75" />
          <Plus
            class="contacts-rail__create-book-plus"
            :size="10"
            :stroke-width="2.6"
          />
        </span>
      </AppButton>
      <AppButton
        class="contacts-rail__create"
        :disabled="kind === 'trash'"
        @click="emit('addContact')"
      >
        <template #iconLeft>
          <Plus :size="16" :stroke-width="2" aria-hidden="true" />
        </template>
        New Contact
      </AppButton>
    </header>

    <div class="contacts-rail__books">
      <button
        class="contacts-rail__book contacts__book"
        type="button"
        :class="{ 'contacts-rail__book--active': kind === 'contacts' && selectedBookId === null }"
        :aria-pressed="kind === 'contacts' && selectedBookId === null"
        @click="emit('selectBook', null)"
        @dragover="onInvalidDragOver"
        @drop.prevent="onInvalidDrop"
      >
        <Users :size="16" :stroke-width="1.75" aria-hidden="true" />
        <span class="contacts-rail__name">All contacts</span>
        <span class="contacts-rail__count">{{ contactCount }}</span>
      </button>

      <button
        v-for="book in addressbooks"
        :key="book.id"
        class="contacts-rail__book contacts__book"
        type="button"
        :class="{
          'contacts-rail__book--active':
            kind === 'contacts' && selectedBookId === book.id,
          'contacts-rail__book--drop-target': hoveredDropTarget === book.id,
          'contacts-rail__book--read-only': book.may_write !== 1,
        }"
        :aria-pressed="kind === 'contacts' && selectedBookId === book.id"
        @click="emit('selectBook', book.id)"
        @dragover="onBookDragOver(book, $event)"
        @dragleave="onBookDragLeave(book, $event)"
        @drop.prevent="onBookDrop(book, $event)"
      >
        <BookUser
          v-if="isTrustedSendersBook(book)"
          :size="16"
          :stroke-width="1.75"
          aria-hidden="true"
        />
        <ContactRound
          v-else
          :size="16"
          :stroke-width="1.75"
          aria-hidden="true"
        />
        <span class="contacts-rail__book-label">
          <span class="contacts-rail__name">{{ addressBookDisplayName(book) }}</span>
          <span v-if="book.is_default === 1" class="contacts-rail__badge">
            Personal
          </span>
        </span>
        <span v-if="hoveredDropTarget === book.id" class="contacts-rail__drop-label">
          Move here
        </span>
        <span v-else class="contacts-rail__count">{{ bookCounts.get(book.id) ?? 0 }}</span>
      </button>

      <button
        class="contacts-rail__book contacts-rail__trash contacts__book"
        type="button"
        :class="{ 'contacts-rail__book--active': kind === 'trash' }"
        :aria-pressed="kind === 'trash'"
        @click="emit('selectTrash')"
        @dragover="onInvalidDragOver"
        @drop.prevent="onInvalidDrop"
      >
        <Trash2 :size="16" :stroke-width="1.75" aria-hidden="true" />
        <span class="contacts-rail__name">Trash</span>
        <span class="contacts-rail__count">{{ trashCount }}</span>
      </button>

      <div class="contacts-rail__identity contacts__identity-section">
        <button
          class="contacts-rail__book contacts__book"
          type="button"
          :class="{ 'contacts-rail__book--active': kind === 'identities' }"
          :aria-pressed="kind === 'identities'"
          @click="emit('selectIdentities')"
          @dragover="onInvalidDragOver"
          @drop.prevent="onInvalidDrop"
        >
          <AtSign :size="16" :stroke-width="1.75" aria-hidden="true" />
          <span class="contacts-rail__name">Manage identities</span>
          <span class="contacts-rail__count">{{ identityCount }}</span>
        </button>
      </div>
    </div>
    <span
      v-if="dropAnnouncement"
      class="contacts-rail__announcement"
      role="status"
      aria-live="polite"
    >
      {{ dropAnnouncement }}
    </span>
  </nav>
</template>

<style scoped>
.contacts-rail {
  display: grid;
  min-width: 0;
  min-height: 0;
  grid-template-rows: auto minmax(0, 1fr);
  overflow: hidden;
  border-right: 1px solid var(--border, #e3e6ee);
  background: var(--folder-list-bg, var(--surface, #fff));
}

.contacts-rail__header {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
  padding: 12px 12px 10px;
  border-bottom: 1px solid var(--border-soft, #eef0f5);
}

.contacts-rail__create {
  min-width: 0;
  flex: 1 1 auto;
  max-width: 100%;
}

/* Icon-only square variant of the filled house button. Doubled with .base
   (services-ui's own class) to outrank its padding, same trick as
   AppButton.vue, so both header buttons share one visual treatment. */
.base.contacts-rail__create-book {
  width: 34px;
  flex: 0 0 34px;
  padding: 0;
}

.contacts-rail__create-book-icon {
  position: relative;
  display: inline-grid;
  width: 20px;
  height: 20px;
  place-items: center;
}

.contacts-rail__create-book-plus {
  position: absolute;
  right: -2px;
  bottom: -1px;
  padding: 1px;
  border-radius: 999px;
  background: var(--colour-primary-default, var(--accent));
}

.contacts-rail__create-book:hover:not(:disabled) .contacts-rail__create-book-plus {
  background: var(--colour-primary-hover, var(--accent));
}

.contacts-rail__create-book:active:not(:disabled) .contacts-rail__create-book-plus {
  background: var(--colour-primary-pressed, var(--accent));
}

.contacts-rail__create-book:disabled .contacts-rail__create-book-plus {
  background: var(--colour-neutral-border, var(--border));
}

.contacts-rail__books {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  gap: 2px;
  padding: 12px 8px;
  overflow-y: auto;
}

.contacts-rail__book {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--text, #1a1d24);
  font: inherit;
  font-size: 14px;
  text-align: left;
  cursor: pointer;
}

.contacts-rail__book > svg {
  width: 16px;
  height: 16px;
  flex: 0 0 16px;
}

.contacts-rail__book:hover,
.contacts-rail__book:focus-visible {
  border-color: var(--border-soft, #eef0f5);
  background: var(--rowHover, #f0f1f6);
  outline: none;
}

.contacts-rail__book--active {
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  font-weight: 600;
}

.contacts-rail__book--active > svg {
  color: var(--accent);
}

.contacts-rail__book--drop-target {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 20%, var(--surface, #fff));
  box-shadow: inset 0 0 0 1px var(--accent);
}

.contacts-rail__book-label {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  align-items: center;
  gap: 5px;
}

.contacts-rail__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.contacts-rail__badge {
  flex: 0 0 auto;
  font-size: 10px;
  font-weight: 600;
  white-space: nowrap;
}

.contacts-rail__badge {
  padding: 1px 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
}

.contacts-rail__drop-label {
  flex: 0 0 auto;
  color: var(--accent);
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
}

.contacts-rail__count {
  min-width: 20px;
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--muted) 18%, transparent);
  color: var(--muted, #6b7388);
  font-size: 12px;
  font-weight: 600;
  text-align: center;
}

.contacts-rail__book--active .contacts-rail__count {
  background: color-mix(in srgb, var(--accent) 26%, transparent);
  color: var(--text, #1a1d24);
}

.contacts-rail__trash {
  margin-top: auto;
}

.contacts-rail__identity {
  margin-top: 0;
  padding-top: 8px;
  border-top: 1px solid var(--border-soft, #eef0f5);
}

.contacts-rail__announcement {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

@media (max-width: 1023px) {
  .contacts-rail {
    grid-template-rows: auto auto;
    border-right: 0;
    border-bottom: 1px solid var(--border, #e3e6ee);
  }

  .contacts-rail__header {
    padding: 8px 12px;
  }

  .contacts-rail__books {
    flex-direction: row;
    gap: 6px;
    padding: 8px 12px;
    overflow-x: auto;
    overflow-y: hidden;
  }

  .contacts-rail__book {
    width: auto;
    flex: 0 0 auto;
    border-color: var(--border, #d6d9e2);
    border-radius: 999px;
  }

  .contacts-rail__trash {
    margin-top: 0;
    margin-left: auto;
  }

  .contacts-rail__identity {
    margin-top: 0;
    margin-left: 0;
    padding-top: 0;
    padding-left: 6px;
    border-top: 0;
    border-left: 1px solid var(--border-soft, #eef0f5);
  }
}

@media (max-width: 639px) {
  .contacts-rail__header,
  .contacts-rail__books {
    padding: 6px 8px;
  }

  .contacts-rail__book {
    padding: 6px 9px;
    font-size: 13px;
  }
}
</style>
