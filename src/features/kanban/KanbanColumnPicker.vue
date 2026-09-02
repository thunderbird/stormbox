<script setup lang="ts">
import { computed } from 'vue';
import { Check, FolderOpen, X } from '@lucide/vue';

import AppDropdown from '../../components/AppDropdown.vue';
import { useMailStore } from '../../stores/mail-store';
import type { FolderRow } from '../../types';
import { closeContainingDropdown } from '../../utils/dropdown';
import { flattenFolderTree, folderPresentation } from '../../utils/folder-presentation';

/**
 * Folder chooser for a configurable kanban column: the folders the
 * sidebar lists for the signed-in account, as an indented tree, minus
 * whatever the other columns show right now, plus an option to leave
 * the column empty.
 */
const props = defineProps<{
  modelValue: number | null;
  /** Folder ids that other columns already display. */
  excludeFolderIds: number[];
  label: string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', folderId: number | null): void;
}>();

const mailStore = useMailStore();

const options = computed(() => flattenFolderTree(mailStore.sidebarPrimaryFolders as FolderRow[])
  .filter(({ folder }) => !props.excludeFolderIds.some((id) => Number(id) === Number(folder.id))
    && Number(folder.is_deleted ?? 0) !== 1));

const selected = computed(() => (props.modelValue == null ? null
  : mailStore.folders.find((f) => Number(f.id) === Number(props.modelValue)) ?? null));

function pick(folderId: number | null, event: Event) {
  emit('update:modelValue', folderId);
  closeContainingDropdown(event);
}

function iconFor(folder: FolderRow) {
  return folderPresentation(folder);
}

function isCurrent(folderId: number | null): boolean {
  if (folderId == null) return props.modelValue == null;
  return Number(folderId) === Number(props.modelValue);
}
</script>

<template>
  <AppDropdown class="kanban-picker">
    <summary
      class="app-dropdown__summary kanban-picker__summary"
      :aria-label="`${label}: ${selected ? selected.name : 'choose a folder'}`"
      :title="selected ? selected.name ?? '' : 'Choose a folder for this column'"
    >
      <span
        v-if="selected"
        class="kanban-picker__icon"
        :style="{ color: iconFor(selected).color }"
        aria-hidden="true"
        v-html="iconFor(selected).icon"
      />
      <FolderOpen v-else class="kanban-picker__icon" :size="16" aria-hidden="true" />
      <span class="kanban-picker__name">{{ selected ? selected.name : 'Choose a folder' }}</span>
    </summary>
    <div class="app-dropdown__menu kanban-picker__menu" role="listbox" :aria-label="label">
      <p v-if="options.length === 0" class="kanban-picker__empty">No other folders</p>
      <button
        v-for="{ folder, depth } in options"
        :key="folder.id"
        type="button"
        class="app-dropdown__item kanban-picker__item"
        :class="{ 'is-current': isCurrent(folder.id) }"
        role="option"
        :aria-selected="isCurrent(folder.id)"
        :style="{ paddingLeft: `${8 + depth * 14}px` }"
        @click="pick(folder.id, $event)"
      >
        <span
          class="kanban-picker__icon"
          :style="{ color: iconFor(folder).color }"
          aria-hidden="true"
          v-html="iconFor(folder).icon"
        />
        <span class="kanban-picker__item-name">{{ folder.name }}</span>
        <Check
          v-if="isCurrent(folder.id)"
          class="kanban-picker__check"
          :size="14"
          aria-hidden="true"
        />
      </button>
      <button
        type="button"
        class="app-dropdown__item kanban-picker__item kanban-picker__item--none"
        role="option"
        :aria-selected="isCurrent(null)"
        data-testid="kanban-picker-none"
        @click="pick(null, $event)"
      >
        <X class="kanban-picker__icon" :size="16" aria-hidden="true" />
        <span class="kanban-picker__item-name">Leave empty</span>
        <Check
          v-if="isCurrent(null)"
          class="kanban-picker__check"
          :size="14"
          aria-hidden="true"
        />
      </button>
    </div>
  </AppDropdown>
</template>

<style scoped>
.kanban-picker {
  min-width: 0;
  flex: 1;
}
.kanban-picker__summary {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
  padding: 2px 4px;
  border-radius: 6px;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.kanban-picker__summary:hover {
  background: rgba(127, 127, 127, 0.14);
}
.kanban-picker__summary:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.kanban-picker__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kanban-picker__icon {
  display: inline-block;
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  color: var(--muted);
}
.kanban-picker__icon :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}
.kanban-picker__icon :deep([fill="context-fill"]) {
  fill: color-mix(in srgb, currentColor 20%, transparent);
}
.kanban-picker__icon :deep([fill="context-stroke"]) {
  fill: currentColor;
}
.kanban-picker__menu {
  min-width: 220px;
}
.kanban-picker__item {
  grid-template-columns: 16px 1fr auto;
}
.kanban-picker__item-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kanban-picker__check {
  color: var(--accent);
}
/* Pinned below the (scrollable) folder list so it is always reachable. */
.kanban-picker__item--none {
  position: sticky;
  bottom: 0;
  margin-top: 4px;
  border-top: 1px solid var(--border);
  padding-top: 8px;
  background: var(--panel);
  color: var(--muted);
}
.kanban-picker__empty {
  margin: 0;
  padding: 6px 8px;
  font-size: 12px;
  color: var(--muted);
}
</style>
