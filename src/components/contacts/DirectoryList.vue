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
  Plus,
  Trash2,
} from '@lucide/vue';

import AppButton from '../AppButton.vue';
import SelectableListHeader from '../SelectableListHeader.vue';
import { useContactDragDrop } from '../../composables/useContactDragDrop';
import { useListSelection } from '../../composables/useListSelection';
import {
  isDeleteKey,
  isModKey,
} from '../../utils/keyboard';
import {
  directoryOptionId,
  type DirectoryEntry,
} from './directory-types';

export interface ContactMoveTarget {
  id: number;
  name: string;
}

const props = withDefaults(defineProps<{
  addLabel: string;
  canDeleteSelection?: boolean;
  canDragContacts?: boolean;
  deleteDisabledReason?: string;
  emptyMessage: string;
  entries: DirectoryEntry[];
  error?: string | null;
  listKind?: 'contacts' | 'identities';
  loading?: boolean;
  moveTargets?: ContactMoveTarget[];
  notice?: string;
  resetToken: string;
  selectedContactIds?: Set<number>;
  selectedKey: string | null;
  sourceAddressbookId?: number | null;
  title: string;
}>(), {
  canDeleteSelection: true,
  canDragContacts: false,
  deleteDisabledReason: '',
  error: null,
  listKind: 'contacts',
  loading: false,
  moveTargets: () => [],
  notice: '',
  selectedContactIds: () => new Set<number>(),
  sourceAddressbookId: null,
});

const emit = defineEmits<{
  add: [];
  deleteSelection: [];
  moveSelection: [addressbookId: number];
  select: [entry: DirectoryEntry];
  selectionChange: [selectedIds: Set<number>];
}>();

const ROW_ESTIMATE = 59;
const scrollEl = ref<HTMLElement | null>(null);
const activeKey = ref<string | null>(null);
const moveMenuOpen = ref(false);
const moveMenuEl = ref<HTMLElement | null>(null);
const selectionEnabled = computed(() => props.listKind === 'contacts');
const selectableCount = computed(() => props.entries.reduce(
  (count, entry) => count + (entry.kind === 'contact' ? 1 : 0),
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
  getKey: (entry) => entry.kind === 'contact' ? entry.contact.id : null,
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

function contactId(entry: DirectoryEntry): number | null {
  return entry.kind === 'contact' ? entry.contact.id : null;
}

function isContactSelected(entry: DirectoryEntry): boolean {
  const id = contactId(entry);
  return id != null && selection.isSelected(id);
}

function toggleContactAt(
  index: number,
  event?: { shiftKey?: boolean } | null,
): void {
  if (!selectionEnabled.value || props.entries[index]?.kind !== 'contact') return;
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
    && entry.kind === 'contact'
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
    emit('deleteSelection');
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
        && props.entries[Math.min(current + 1, props.entries.length - 1)]?.kind === 'contact'
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
        && props.entries[Math.max(current - 1, 0)]?.kind === 'contact'
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
      if (selectionEnabled.value && entry.kind === 'contact') {
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
      (entry) => entry.kind === 'contact' ? [entry.contact.id] : [],
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
      :item-label="listKind === 'contacts' ? 'contacts' : 'identities'"
      :selectable="selectionEnabled"
      :selected-count="selection.selectionCount.value"
      :singular-item-label="listKind === 'contacts' ? 'contact' : 'identity'"
      :total-count="entries.length"
      @clear-selection="selection.selectNone"
      @toggle-all="toggleAll"
    >
      <template #normal-actions>
        <div class="directory-list__normal-header">
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
        <div ref="moveMenuEl" class="directory-list__move">
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
          :title="canDeleteSelection ? 'Delete selected contacts' : deleteDisabledReason"
          @click="emit('deleteSelection')"
        >
          <Trash2 :size="16" :stroke-width="1.9" aria-hidden="true" />
          <span>Delete</span>
        </button>
      </template>
    </SelectableListHeader>

    <p v-if="notice" class="directory-list__notice" role="status" aria-live="polite">
      {{ notice }}
    </p>

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
              entry.kind === 'contact'
                ? isContactSelected(entry)
                : selectedKey === entry.key,
            'directory-list__row--viewed':
              entry.kind === 'contact' && selectedKey === entry.key,
            'directory-list__row--contact': entry.kind === 'contact',
          }"
          role="option"
          :aria-selected="
            entry.kind === 'contact'
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
            v-if="entry.kind === 'contact'"
            class="directory-list__checkbox"
            :title="isContactSelected(entry) ? 'Deselect contact' : 'Select contact'"
            @click.stop
          >
            <input
              type="checkbox"
              :checked="isContactSelected(entry)"
              :aria-label="`Select ${entry.name || entry.email || 'contact'}`"
              @click="toggleContactAt(virtualRow.index, $event)"
            />
          </label>
          <span class="directory-list__row-content">
            <span class="name">{{ entry.name }}</span>
            <span class="email">{{ entry.email }}</span>
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
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.directory-list__normal-header h2 {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  font-size: 16px;
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

.name,
.email {
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
