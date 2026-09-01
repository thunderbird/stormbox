<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  ref,
  watch,
} from 'vue';
import { useVirtualizer } from '@tanstack/vue-virtual';
import { onClickOutside } from '@vueuse/core';
import {
  ChevronDown,
  MoveRight,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
} from '@lucide/vue';

import AppButton from '../AppButton.vue';
import AppIconButton from '../AppIconButton.vue';
import SelectableListHeader from '../SelectableListHeader.vue';
import { useContactDragDrop } from '../../composables/useContactDragDrop';
import { useListSelection } from '../../composables/useListSelection';
import { addressBookErrorMessage } from '../../constants/addressbook-errors';
import type { AddressbookRow } from '../../types';
import { addressBookDeleteDisabledReason } from '../../utils/address-book-policy';
import {
  isDeleteKey,
  isModKey,
} from '../../utils/keyboard';
import {
  addressBookDisplayName,
  directoryOptionId,
  type DirectoryEntry,
  type DirectoryKind,
} from './directory-types';
import ContactAvatar from './ContactAvatar.vue';

export interface ContactMoveTarget {
  id: number;
  name: string;
}

const props = withDefaults(defineProps<{
  addLabel: string;
  addressbooks?: AddressbookRow[];
  canDeleteSelection?: boolean;
  canDragContacts?: boolean;
  deleteDisabledReason?: string;
  emptyMessage: string;
  entries: DirectoryEntry[];
  error?: string | null;
  listKind?: DirectoryKind;
  loading?: boolean;
  moveTargets?: ContactMoveTarget[];
  notice?: string;
  primaryIdentityId?: number | null;
  resetToken: string;
  selectedContactIds?: Set<number>;
  selectedKey: string | null;
  sourceAddressbookId?: number | null;
  title: string;
}>(), {
  addressbooks: () => [],
  canDeleteSelection: true,
  canDragContacts: false,
  deleteDisabledReason: '',
  error: null,
  listKind: 'contacts',
  loading: false,
  moveTargets: () => [],
  notice: '',
  primaryIdentityId: null,
  selectedContactIds: () => new Set<number>(),
  sourceAddressbookId: null,
});

const emit = defineEmits<{
  add: [];
  deleteAddressBook: [addressbook: AddressbookRow];
  deleteSelection: [];
  deleteForeverSelection: [];
  editAddressBook: [addressbook: AddressbookRow];
  moveSelection: [addressbookId: number];
  restoreSelection: [];
  select: [entry: DirectoryEntry];
  selectionChange: [selectedIds: Set<number>];
}>();

const ROW_ESTIMATE = 59;
const scrollEl = ref<HTMLElement | null>(null);
const activeKey = ref<string | null>(null);
const moveMenuOpen = ref(false);
const moveMenuEl = ref<HTMLElement | null>(null);
const concreteAddressBook = computed(() =>
  props.listKind === 'contacts' && props.sourceAddressbookId != null
    ? props.addressbooks.find((book) => book.id === props.sourceAddressbookId) ?? null
    : null);
const addressBookDeleteReason = computed(() => {
  if (!concreteAddressBook.value) return null;
  const reason = addressBookDeleteDisabledReason(
    concreteAddressBook.value,
    props.addressbooks,
  );
  return reason ? addressBookErrorMessage(reason) : null;
});
const showAddressbookColumn = computed(() =>
  props.listKind === 'contacts' && props.sourceAddressbookId == null);
const addressbookLabels = computed(() => {
  const labels = new Map<number, string>();
  for (const book of props.addressbooks) {
    labels.set(book.id, addressBookDisplayName(book));
  }
  return labels;
});
const selectionEnabled = computed(() =>
  props.listKind === 'contacts' || props.listKind === 'trash');
const selectableCount = computed(() => props.entries.reduce(
  (count, entry) => count + (entry.kind === 'contact' || entry.kind === 'trash' ? 1 : 0),
  0,
));
const selectionModel = computed<Set<number>>({
  get: () => props.selectedContactIds,
  set: (ids) => emit('selectionChange', ids),
});
const selection = useListSelection<DirectoryEntry, number>({
  rows: computed(() => props.entries),
  total: selectableCount,
  selectedIds: selectionModel,
  getKey: (entry) => {
    switch (entry.kind) {
      case 'contact':
        return entry.contact.id;
      case 'trash':
        return entry.trash.id;
      case 'identity':
        return null;
      default: {
        const exhaustive: never = entry;
        return exhaustive;
      }
    }
  },
});
const allSelected = computed(() =>
  selectableCount.value > 0
  && selection.selectionCount.value === selectableCount.value);
const {
  endContactDrag,
  startContactDrag,
} = useContactDragDrop();

onClickOutside(moveMenuEl, () => {
  moveMenuOpen.value = false;
});
const virtualizer = useVirtualizer(
  computed(() => ({
    count: props.entries.length,
    getScrollElement: () => scrollEl.value,
    estimateSize: () => ROW_ESTIMATE,
    overscan: 8,
    getItemKey: (index: number) => props.entries[index]?.key ?? `missing:${index}`,
  })),
);
const totalSize = computed(() => virtualizer.value.getTotalSize());
const renderedEntries = computed(() => virtualizer.value.getVirtualItems()
  .map((virtualRow) => ({
    virtualRow,
    entry: props.entries[virtualRow.index],
  }))
  .filter((rendered): rendered is typeof rendered & { entry: DirectoryEntry } =>
    rendered.entry != null));
const activeDescendant = computed(() =>
  activeKey.value ? directoryOptionId(activeKey.value) : undefined);

function entryIndex(key: string | null): number {
  if (!key) return -1;
  return props.entries.findIndex((entry) => entry.key === key);
}

function initialActiveKey(): string | null {
  if (entryIndex(props.selectedKey) >= 0) return props.selectedKey;
  return props.entries[0]?.key ?? null;
}

function measureElement(element: Element | null): void {
  if (element) virtualizer.value.measureElement(element);
}

async function scrollToEntryIndex(index: number): Promise<void> {
  virtualizer.value.scrollToIndex(index, { align: 'auto' });
  await nextTick();
  const key = props.entries[index]?.key;
  if (!key || scrollEl.value?.querySelector(`#${directoryOptionId(key)}`)) return;
  virtualizer.value.measure();
  virtualizer.value.scrollToIndex(index, { align: 'center' });
  await nextTick();
  virtualizer.value.scrollToIndex(index, { align: 'auto' });
  await nextTick();
}

async function setActiveIndex(index: number): Promise<void> {
  if (props.entries.length === 0) {
    activeKey.value = null;
    return;
  }
  const bounded = Math.max(0, Math.min(index, props.entries.length - 1));
  activeKey.value = props.entries[bounded].key;
  await scrollToEntryIndex(bounded);
}

async function resetList(): Promise<void> {
  activeKey.value = entryIndex(props.selectedKey) >= 0 ? props.selectedKey : null;
  moveMenuOpen.value = false;
  selection.selectNone();
  await nextTick();
  virtualizer.value.scrollToOffset(0);
  if (props.selectedKey) {
    const selectedIndex = entryIndex(props.selectedKey);
    if (selectedIndex >= 0) await scrollToEntryIndex(selectedIndex);
  }
}

function selectEntry(entry: DirectoryEntry): void {
  activeKey.value = entry.key;
  moveMenuOpen.value = false;
  emit('select', entry);
}

function onListFocusIn(): void {
  if (entryIndex(activeKey.value) < 0) activeKey.value = initialActiveKey();
}

function selectableId(entry: DirectoryEntry): number | null {
  if (entry.kind === 'contact') return entry.contact.id;
  if (entry.kind === 'trash') return entry.trash.id;
  return null;
}

function isContactSelected(entry: DirectoryEntry): boolean {
  const id = selectableId(entry);
  return id != null && selection.isSelected(id);
}

function addressbookLabel(entry: Extract<DirectoryEntry, { kind: 'contact' }>): string {
  const names = entry.contact.addressbook_ids
    .map((id) => addressbookLabels.value.get(id))
    .filter((name): name is string => name != null);
  return names.length > 0 ? names.join(', ') : 'No address book';
}

function toggleContactAt(
  index: number,
  event?: { shiftKey?: boolean } | null,
): void {
  if (!selectionEnabled.value || props.entries[index]?.kind === 'identity') return;
  activeKey.value = props.entries[index].key;
  selection.handleCheckboxClick(index, event, index);
}

function onPointerSelect(
  entry: DirectoryEntry,
  index: number,
  event: MouseEvent,
): void {
  if (
    selectionEnabled.value
    && entry.kind !== 'identity'
    && (event.shiftKey || event.ctrlKey || event.metaKey)
  ) {
    toggleContactAt(index, event);
  } else {
    selectEntry(entry);
  }
  scrollEl.value?.focus();
}

function onKeydown(event: KeyboardEvent): void {
  if (moveMenuOpen.value && event.key === 'Escape') {
    event.preventDefault();
    moveMenuOpen.value = false;
    return;
  }
  if (selectionEnabled.value && isModKey(event) && event.key.toLowerCase() === 'a') {
    event.preventDefault();
    if (allSelected.value) selection.selectNone();
    else selection.selectAllLoaded();
    return;
  }
  if (
    selectionEnabled.value
    && event.key === 'Escape'
    && selection.hasSelection.value
  ) {
    event.preventDefault();
    selection.selectNone();
    return;
  }
  if (
    selectionEnabled.value
    && isDeleteKey(event)
    && selection.hasSelection.value
    && props.canDeleteSelection
  ) {
    event.preventDefault();
    if (props.listKind === 'trash') emit('deleteForeverSelection');
    else emit('deleteSelection');
    return;
  }
  if (props.entries.length === 0) return;
  const activeIndex = entryIndex(activeKey.value);
  if (activeIndex < 0 && [
    'ArrowDown',
    'ArrowUp',
    'Home',
    'End',
  ].includes(event.key)) {
    event.preventDefault();
    void setActiveIndex(
      event.key === 'ArrowUp' || event.key === 'End'
        ? props.entries.length - 1
        : 0,
    );
    return;
  }
  if (activeIndex < 0) activeKey.value = initialActiveKey();
  const current = Math.max(0, entryIndex(activeKey.value));
  switch (event.key) {
    case 'ArrowDown': {
      event.preventDefault();
      if (
        event.shiftKey
        && selectionEnabled.value
        && props.entries[Math.min(current + 1, props.entries.length - 1)]?.kind !== 'identity'
      ) {
        selection.extendRange(
          Math.min(current + 1, props.entries.length - 1),
          current,
        );
      }
      void setActiveIndex(current + 1);
      return;
    }
    case 'ArrowUp': {
      event.preventDefault();
      if (
        event.shiftKey
        && selectionEnabled.value
        && props.entries[Math.max(current - 1, 0)]?.kind !== 'identity'
      ) {
        selection.extendRange(Math.max(current - 1, 0), current);
      }
      void setActiveIndex(current - 1);
      return;
    }
    case 'Home':
      event.preventDefault();
      void setActiveIndex(0);
      return;
    case 'End':
      event.preventDefault();
      void setActiveIndex(props.entries.length - 1);
      return;
    case 'Enter': {
      event.preventDefault();
      const entry = props.entries[entryIndex(activeKey.value)];
      if (entry) emit('select', entry);
      return;
    }
    case ' ':
    case 'Spacebar': {
      const entry = props.entries[entryIndex(activeKey.value)];
      if (!entry) return;
      event.preventDefault();
      if (selectionEnabled.value && entry.kind !== 'identity') {
        toggleContactAt(entryIndex(entry.key));
      } else {
        emit('select', entry);
      }
      return;
    }
    default:
  }
}

function toggleAll(): void {
  if (selection.hasSelection.value) selection.selectNone();
  else selection.selectAllLoaded();
}

function chooseMoveTarget(addressbookId: number): void {
  moveMenuOpen.value = false;
  emit('moveSelection', addressbookId);
}

function onDragStart(entry: DirectoryEntry, event: DragEvent): void {
  if (
    entry.kind !== 'contact'
    || !props.canDragContacts
    || props.sourceAddressbookId == null
  ) {
    event.preventDefault();
    return;
  }
  startContactDrag(event, {
    contactId: entry.contact.id,
    selectedIds: props.selectedContactIds,
    sourceAddressbookId: props.sourceAddressbookId,
  });
}

async function focusSelected(): Promise<void> {
  activeKey.value = initialActiveKey();
  const index = entryIndex(activeKey.value);
  if (index >= 0) await scrollToEntryIndex(index);
  else await nextTick();
  scrollEl.value?.focus();
}

watch(
  () => props.resetToken,
  () => {
    void resetList();
  },
  { immediate: true },
);

watch(
  () => props.entries.map((entry) => entry.key).join('\u0000'),
  () => {
    if (activeKey.value != null && entryIndex(activeKey.value) < 0) {
      activeKey.value = entryIndex(props.selectedKey) >= 0 ? props.selectedKey : null;
    }
    selection.retainOnly(props.entries.flatMap(
      (entry) => entry.kind === 'contact'
        ? [entry.contact.id]
        : (entry.kind === 'trash' ? [entry.trash.id] : []),
    ));
  },
);

watch(
  () => props.selectedKey,
  (key) => {
    const index = entryIndex(key);
    if (index < 0) return;
    activeKey.value = key;
    void scrollToEntryIndex(index);
  },
);

defineExpose({ focusSelected });

onBeforeUnmount(endContactDrag);
</script>

<template>
  <section class="directory-list">
    <SelectableListHeader
      class="directory-list__header contacts__header"
      :all-selected="allSelected"
      :disabled="loading"
      :item-label="
        listKind === 'contacts'
          ? 'contacts'
          : (listKind === 'trash' ? 'trashed contacts' : 'identities')
      "
      :selectable="selectionEnabled"
      :selected-count="selection.selectionCount.value"
      :singular-item-label="
        listKind === 'contacts'
          ? 'contact'
          : (listKind === 'trash' ? 'trashed contact' : 'identity')
      "
      :total-count="entries.length"
      @clear-selection="selection.selectNone"
      @toggle-all="toggleAll"
    >
      <template #normal-actions>
        <div
          class="directory-list__normal-header"
          :class="{
            'directory-list__normal-header--addressbook': listKind === 'contacts',
          }"
        >
          <div
            v-if="concreteAddressBook"
            class="directory-list__addressbook-actions"
            role="group"
            aria-label="Address book actions"
          >
            <AppIconButton
              :disabled="concreteAddressBook.may_write !== 1"
              :title="concreteAddressBook.may_write === 1
                ? 'Edit address book'
                : 'You don’t have permission to edit this address book.'"
              aria-label="Edit address book"
              @click="emit('editAddressBook', concreteAddressBook)"
            >
              <Pencil :size="17" :stroke-width="1.75" aria-hidden="true" />
            </AppIconButton>
            <AppIconButton
              danger
              :disabled="addressBookDeleteReason !== null"
              :title="addressBookDeleteReason || 'Delete address book'"
              aria-label="Delete address book"
              @click="emit('deleteAddressBook', concreteAddressBook)"
            >
              <Trash2 :size="17" :stroke-width="1.75" aria-hidden="true" />
            </AppIconButton>
          </div>
          <h2>{{ title }}</h2>
          <AppButton
            v-if="listKind === 'identities'"
            class="contacts__add"
            @click="emit('add')"
          >
            <template #iconLeft>
              <Plus :size="16" :stroke-width="2" aria-hidden="true" />
            </template>
            {{ addLabel }}
          </AppButton>
        </div>
      </template>

      <template #selection-actions>
        <button
          v-if="listKind === 'trash'"
          class="directory-list__action"
          type="button"
          @click="emit('restoreSelection')"
        >
          <RotateCcw :size="16" :stroke-width="1.9" aria-hidden="true" />
          <span>Restore</span>
        </button>
        <div v-if="listKind === 'contacts'" ref="moveMenuEl" class="directory-list__move">
          <button
            class="directory-list__action"
            type="button"
            :disabled="moveTargets.length === 0"
            :aria-expanded="moveMenuOpen"
            aria-haspopup="menu"
            title="Move to address book"
            @click="moveMenuOpen = !moveMenuOpen"
          >
            <MoveRight :size="16" :stroke-width="1.9" aria-hidden="true" />
            <span>Move</span>
            <ChevronDown :size="13" :stroke-width="1.9" aria-hidden="true" />
          </button>
          <div
            v-if="moveMenuOpen"
            class="directory-list__move-menu"
            role="menu"
            aria-label="Move to address book"
          >
            <button
              v-for="target in moveTargets"
              :key="target.id"
              type="button"
              role="menuitem"
              @click="chooseMoveTarget(target.id)"
            >
              {{ target.name }}
            </button>
          </div>
        </div>
        <button
          class="directory-list__action directory-list__action--danger"
          type="button"
          :disabled="!canDeleteSelection"
          :title="
            canDeleteSelection
              ? (
                listKind === 'trash'
                  ? 'Delete selected contacts forever'
                  : 'Delete selected contacts'
              )
              : deleteDisabledReason
          "
          @click="
            listKind === 'trash'
              ? emit('deleteForeverSelection')
              : emit('deleteSelection')
          "
        >
          <Trash2 :size="16" :stroke-width="1.9" aria-hidden="true" />
          <span>{{ listKind === 'trash' ? 'Delete Forever' : 'Delete' }}</span>
        </button>
      </template>
    </SelectableListHeader>

    <p v-if="notice" class="directory-list__notice" role="status" aria-live="polite">
      {{ notice }}
    </p>

    <div
      v-if="showAddressbookColumn && !loading && !error && entries.length > 0"
      class="directory-list__column-header"
      aria-hidden="true"
    >
      <span />
      <span />
      <span>Contact</span>
      <span>Address book</span>
    </div>

    <div
      ref="scrollEl"
      class="directory-list__viewport contacts__list"
      role="listbox"
      tabindex="0"
      :aria-label="title"
      :aria-activedescendant="activeDescendant"
      :aria-busy="loading"
      :aria-multiselectable="selectionEnabled ? 'true' : undefined"
      @focusin="onListFocusIn"
      @keydown="onKeydown"
    >
      <p v-if="loading" class="contacts__empty" role="status">
        Loading…
      </p>
      <p v-else-if="error" class="contacts__empty contacts__empty--error" role="alert">
        {{ error }}
      </p>
      <p v-else-if="entries.length === 0" class="contacts__empty">
        {{ emptyMessage }}
      </p>
      <div
        v-else
        class="directory-list__spacer contacts__list-spacer"
        role="presentation"
        :style="{ height: `${totalSize}px` }"
      >
        <div
          v-for="{ virtualRow, entry } in renderedEntries"
          :id="directoryOptionId(entry.key)"
          :key="entry.key"
          :ref="measureElement"
          :data-index="virtualRow.index"
          :data-entry-key="entry.key"
          class="directory-list__row contacts__row"
          :class="{
            'directory-list__row--active': activeKey === entry.key,
            'directory-list__row--selected':
              entry.kind !== 'identity'
                ? isContactSelected(entry)
                : selectedKey === entry.key,
            'directory-list__row--viewed':
              entry.kind !== 'identity' && selectedKey === entry.key,
            'directory-list__row--contact': entry.kind !== 'identity',
            'directory-list__row--active-contact': entry.kind === 'contact',
            'directory-list__row--with-addressbook':
              showAddressbookColumn && entry.kind === 'contact',
            'directory-list__row--primary-identity':
              entry.kind === 'identity' && entry.identity.id === primaryIdentityId,
          }"
          role="option"
          :aria-selected="
            entry.kind !== 'identity'
              ? (
                selection.selectionCount.value > 0
                  ? isContactSelected(entry)
                  : selectedKey === entry.key
              )
              : selectedKey === entry.key
          "
          :aria-current="selectedKey === entry.key ? 'true' : undefined"
          :aria-posinset="virtualRow.index + 1"
          :aria-setsize="entries.length"
          :style="{ transform: `translateY(${virtualRow.start}px)` }"
          :draggable="
            entry.kind === 'contact'
              && canDragContacts
              && sourceAddressbookId != null
          "
          @click="onPointerSelect(entry, virtualRow.index, $event)"
          @dragstart="onDragStart(entry, $event)"
          @dragend="endContactDrag"
        >
          <label
            v-if="entry.kind !== 'identity'"
            class="directory-list__checkbox"
            :title="
              isContactSelected(entry)
                ? `Deselect ${entry.kind === 'trash' ? 'trashed contact' : 'contact'}`
                : `Select ${entry.kind === 'trash' ? 'trashed contact' : 'contact'}`
            "
            @click.stop
          >
            <input
              type="checkbox"
              :checked="isContactSelected(entry)"
              :aria-label="`Select ${entry.name || entry.email || 'contact'}`"
              @click="toggleContactAt(virtualRow.index, $event)"
            />
          </label>
          <ContactAvatar
            v-if="entry.kind === 'contact'"
            :email="entry.contact.email"
            :name="entry.contact.display_name"
            :photo="entry.contact.photo"
          />
          <span
            v-if="entry.kind === 'identity' && entry.identity.id === primaryIdentityId"
            class="directory-list__primary-badge"
          >
            Primary
          </span>
          <span class="directory-list__row-content">
            <span class="name">{{ entry.name }}</span>
            <span class="email">{{ entry.email }}</span>
          </span>
          <span
            v-if="showAddressbookColumn && entry.kind === 'contact'"
            class="addressbook"
          >
            {{ addressbookLabel(entry) }}
          </span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.directory-list {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  border-right: 1px solid var(--border, #e3e6ee);
  background: var(--surface, #fff);
}

.directory-list__header {
  min-height: 57px;
  padding: 11px 12px;
  --selectable-list-header-min-height: 57px;
  --selectable-list-header-padding: 11px 12px;
}

.directory-list__normal-header {
  position: relative;
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.directory-list__normal-header--addressbook {
  justify-content: center;
}

.directory-list__addressbook-actions {
  position: absolute;
  z-index: 1;
  left: 0;
  display: flex;
  align-items: center;
  gap: 2px;
}

.directory-list__normal-header h2 {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  font-size: 16px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.directory-list__normal-header--addressbook h2 {
  max-width: calc(100% - 156px);
  text-align: center;
}

.directory-list__column-header {
  display: grid;
  grid-template-columns: 34px 34px repeat(2, minmax(0, 1fr));
  gap: 8px;
  padding: 6px 16px 6px 10px;
  border-bottom: 1px solid var(--border-soft, #eef0f5);
  color: var(--muted, #6b7388);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}

.directory-list__column-header > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.contacts__add {
  flex: none;
  white-space: nowrap;
}

.directory-list__move {
  position: relative;
}

.directory-list__action {
  display: inline-flex;
  min-height: 34px;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 0 9px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--text, #1a1d24);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.directory-list__action:hover:not(:disabled),
.directory-list__action:focus-visible {
  border-color: var(--border, #e3e6ee);
  background: var(--rowHover, #f0f1f6);
  outline: none;
}

.directory-list__action--danger {
  color: var(--danger, #c93838);
}

.directory-list__action:disabled {
  cursor: not-allowed;
  opacity: 0.48;
}

.directory-list__move-menu {
  position: absolute;
  z-index: 20;
  top: calc(100% + 5px);
  left: 0;
  display: grid;
  min-width: 190px;
  max-height: 240px;
  overflow-y: auto;
  padding: 5px;
  border: 1px solid var(--border, #e3e6ee);
  border-radius: 8px;
  background: var(--surface, #fff);
  box-shadow: 0 10px 30px rgb(15 23 42 / 18%);
}

.directory-list__move-menu button {
  padding: 8px 10px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text, #1a1d24);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.directory-list__move-menu button:hover,
.directory-list__move-menu button:focus-visible {
  background: var(--rowHover, #f0f1f6);
  outline: none;
}

.directory-list__notice {
  margin: 0;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border-soft, #eef0f5);
  background: color-mix(in srgb, var(--accent) 8%, var(--surface, #fff));
  color: var(--muted, #6b7388);
  font-size: 12px;
}

.directory-list__viewport {
  min-height: 0;
  flex: 1 1 auto;
  overflow-y: auto;
  outline: none;
}

.directory-list__viewport:focus-visible {
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--accent) 65%, transparent);
}

.directory-list__spacer {
  position: relative;
  width: 100%;
}

.directory-list__row {
  position: absolute;
  top: 0;
  left: 0;
  display: grid;
  width: 100%;
  min-height: 58px;
  grid-template-columns: minmax(0, 1fr);
  align-content: center;
  gap: 3px;
  padding: 9px 16px;
  border-bottom: 1px solid var(--border-soft, #eef0f5);
  cursor: default;
  user-select: none;
}

.directory-list__row--contact {
  grid-template-columns: 34px minmax(0, 1fr);
  column-gap: 8px;
  padding-inline-start: 10px;
}

.directory-list__row--active-contact {
  grid-template-columns: 34px 34px minmax(0, 1fr);
}

.directory-list__row--with-addressbook {
  grid-template-columns: 34px 34px minmax(0, 1fr) minmax(0, 1fr);
}

.directory-list__row--primary-identity {
  grid-template-columns: auto minmax(0, 1fr);
  column-gap: 8px;
}

.directory-list__row:hover {
  background: var(--rowHover, #f0f1f6);
}

.directory-list__row--active {
  z-index: 1;
  outline: 2px solid color-mix(in srgb, var(--accent) 70%, transparent);
  outline-offset: -2px;
}

.directory-list__row--selected {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}

.directory-list__row--viewed:not(.directory-list__row--selected) {
  box-shadow: inset 3px 0 0 var(--accent);
}

.directory-list__checkbox {
  display: grid;
  width: 34px;
  height: 34px;
  align-self: center;
  place-items: center;
  cursor: pointer;
}

.directory-list__checkbox input {
  width: 15px;
  height: 15px;
  margin: 0;
  accent-color: var(--accent);
  cursor: pointer;
}

.directory-list__row-content {
  display: grid;
  min-width: 0;
  align-content: center;
  gap: 3px;
}

.directory-list__primary-badge {
  align-self: center;
  padding: 2px 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
}

.name,
.email,
.addressbook {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.name {
  font-size: 14px;
  font-weight: 600;
}

.email {
  color: var(--muted, #6b7388);
  font-size: 12px;
}

.addressbook {
  color: var(--muted, #6b7388);
  font-size: 12px;
}

.contacts__empty {
  margin: 0;
  padding: 24px;
  color: var(--muted, #6b7388);
}

.contacts__empty--error {
  color: #c93838;
}

@media (max-width: 639px) {
  .directory-list {
    border-right: 0;
  }

  .directory-list__header {
    padding-inline: 10px;
    --selectable-list-header-padding: 10px;
  }

  .directory-list__action span {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
}
</style>
