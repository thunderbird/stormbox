<script setup lang="ts">
import { computed, ref } from 'vue';

import { useMenuKeyboard } from '../composables/useMenuKeyboard';
import { useMailStore } from '../stores/mail-store';
import { closeContainingDropdown } from '../utils/dropdown';
import { flattenFolderTree, folderPresentation } from '../utils/folder-presentation';
import type { FolderRow } from '../types';
import AppDropdown from './AppDropdown.vue';

/**
 * The folder shown at the start of a column's header row: a static
 * title on the primary column (its folder is the folder list's pick),
 * a dropdown listing the folder list's folders on every other column.
 * The only flexible item in the row: the name truncates so the controls
 * after it keep their place at any width.
 */
const props = withDefaults(defineProps<{
  primary: boolean;
  folder: FolderRow | null;
  folderId: number | null;
  /** 1-based column position, for the dropdown's accessible names. */
  columnIndex?: number;
  /** Narrow header: the trigger drops its icon and padding so the name keeps room. */
  compact?: boolean;
}>(), {
  columnIndex: 1,
  compact: false,
});

const emit = defineEmits<{
  pick: [folderId: number];
}>();

const mailStore = useMailStore();

const folderName = computed(() => props.folder?.name ?? 'Mail');
const folderIcon = computed(() => (props.folder ? folderPresentation(props.folder).icon : ''));
const folderTone = computed(() => (props.folder ? folderPresentation(props.folder).color : undefined));

interface FolderOption {
  folder: FolderRow;
  depth: number;
  icon: string;
  color: string;
}
interface FolderOptionGroup {
  key: string;
  label: string | null;
  options: FolderOption[];
}

function optionsFor(rows: FolderRow[]): FolderOption[] {
  return flattenFolderTree(rows.filter((row) => Number(row.is_deleted) !== 1))
    .map(({ folder: row, depth }) => ({ folder: row, depth, ...folderPresentation(row) }));
}

// The folders the folder list shows (system folders plus subscribed
// ones, then one group per shared account), in structural order with
// the folder list's icons.
const folderOptionGroups = computed<FolderOptionGroup[]>(() => {
  const own = mailStore.accounts.find((account) => Number(account.is_primary) === 1) ?? null;
  const shared = mailStore.sharedFolderGroups;
  const groups: FolderOptionGroup[] = [{
    key: 'primary',
    // The own account is named only when another account's folders follow.
    label: shared.length > 0 ? (own?.display_name ?? own?.primary_email ?? 'My account') : null,
    options: optionsFor(mailStore.sidebarPrimaryFolders),
  }];
  for (const group of shared) {
    const options = optionsFor(group.folders);
    if (options.length === 0) continue;
    groups.push({
      key: `account-${group.account.id}`,
      label: group.account.display_name ?? group.account.primary_email ?? 'Shared',
      options,
    });
  }
  return groups;
});

const triggerEl = ref<HTMLElement | null>(null);
const menuEl = ref<HTMLElement | null>(null);

// The listbox opens on the chosen folder (or its first option).
const { onToggle, onKeydown } = useMenuKeyboard({
  menuEl,
  itemSelector: '[role="option"]',
  initialItem: (items) => items.find((item) => item.getAttribute('aria-selected') === 'true'),
});

function pickFolder(id: number, event: Event) {
  closeContainingDropdown(event);
  if (id !== props.folderId) emit('pick', id);
  triggerEl.value?.focus();
}

/** Focus the dropdown trigger (a newly added column starts here). */
function focusTrigger() {
  triggerEl.value?.focus();
}

defineExpose({ focusTrigger });
</script>

<template>
  <h2 v-if="primary" class="msg-list__title" :title="folderName">
    <span
      v-if="folderIcon"
      class="msg-list__title-icon"
      :style="{ '--folder-tone': folderTone }"
      aria-hidden="true"
      v-html="folderIcon"
    />
    <span class="msg-list__title-name">{{ folder ? folderName : 'Messages' }}</span>
  </h2>
  <AppDropdown v-else class="msg-list__folder-picker" group="message-columns" @toggle="onToggle">
    <summary
      ref="triggerEl"
      class="app-dropdown__summary msg-list__folder-trigger"
      :class="{
        'msg-list__folder-trigger--empty': !folder,
        'msg-list__folder-trigger--compact': compact,
      }"
      aria-haspopup="listbox"
      :aria-label="folder ? `Folder for column ${columnIndex}: ${folderName}` : `Choose a folder for column ${columnIndex}`"
      :title="folder ? folderName : 'Choose a folder'"
    >
      <span
        v-if="folderIcon && !compact"
        class="msg-list__title-icon"
        :style="{ '--folder-tone': folderTone }"
        aria-hidden="true"
        v-html="folderIcon"
      />
      <span class="msg-list__title-name">{{ folder ? folderName : 'Choose a folder…' }}</span>
    </summary>
    <div
      ref="menuEl"
      class="app-dropdown__menu msg-list__folder-menu"
      role="listbox"
      :aria-label="`Folders for column ${columnIndex}`"
      @keydown="onKeydown"
    >
      <div
        v-for="group in folderOptionGroups"
        :key="group.key"
        role="group"
        :aria-label="group.label ?? undefined"
      >
        <div v-if="group.label" class="app-dropdown__heading msg-list__folder-heading" :title="group.label">
          {{ group.label }}
        </div>
        <button
          v-for="option in group.options"
          :key="option.folder.id"
          class="app-dropdown__item msg-list__folder-option"
          type="button"
          tabindex="-1"
          role="option"
          :aria-selected="option.folder.id === folderId"
          :style="{ '--folder-tone': option.color, paddingLeft: `${8 + option.depth * 14}px` }"
          @click="pickFolder(option.folder.id, $event)"
        >
          <span class="msg-list__folder-option-icon" aria-hidden="true" v-html="option.icon" />
          <span class="msg-list__folder-option-name">{{ option.folder.name || '(unnamed)' }}</span>
        </button>
      </div>
    </div>
  </AppDropdown>
</template>

<style scoped>
.msg-list__title,
.msg-list__folder-picker {
  flex: 1 1 0;
  min-width: 0;
}
.msg-list__title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}
.msg-list__title-icon {
  display: block;
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  color: var(--folder-tone, var(--muted));
}
.msg-list__title-icon :deep(svg),
.msg-list__folder-option-icon :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}
.msg-list__title-icon :deep([fill="context-fill"]),
.msg-list__folder-option-icon :deep([fill="context-fill"]) {
  fill: color-mix(in srgb, currentColor 20%, transparent);
}
.msg-list__title-icon :deep([fill="context-stroke"]),
.msg-list__folder-option-icon :deep([fill="context-stroke"]) {
  fill: currentColor;
}
.msg-list__title-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.msg-list__folder-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  min-height: 34px;
  padding: 4px 8px;
  border: 1px solid var(--control-border);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
  font: inherit;
  font-size: 14px;
  font-weight: 600;
}
.msg-list__folder-trigger:focus-visible {
  border-color: var(--accent);
  outline: none;
}
.msg-list__folder-trigger::after {
  flex-shrink: 0;
}
.msg-list__folder-trigger--empty {
  color: var(--muted);
  font-weight: 500;
}
.msg-list__folder-trigger--compact {
  gap: 4px;
  padding: 4px 6px;
}
.msg-list__folder-trigger--compact::after {
  margin-left: 2px;
}
.msg-list__folder-menu {
  /* At least as wide as the trigger it hangs from. */
  min-width: max(220px, 100%);
  max-width: min(360px, 80vw);
}
.msg-list__folder-heading {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.msg-list__folder-option {
  width: 100%;
}
.msg-list__folder-option[aria-selected="true"] {
  background: var(--rowActive);
}
.msg-list__folder-option:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.msg-list__folder-option-icon {
  display: block;
  width: 18px;
  height: 18px;
  color: var(--folder-tone, var(--muted));
}
.msg-list__folder-option-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
