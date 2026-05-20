<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps({
  folder: { type: Object, required: true },
  currentFolderId: { type: [Number, String, null], default: null },
  onPick: { type: Function, required: true },
  dropState: { type: Function, default: null },
  onFolderDragEnter: { type: Function, default: null },
  onFolderDragOver: { type: Function, default: null },
  onFolderDragLeave: { type: Function, default: null },
  onFolderDrop: { type: Function, default: null },
});

const current = computed(() => props.currentFolderId === props.folder.id);
const unread = computed(() => Number(props.folder.unread_emails) || 0);
const Icon = computed(() => props.folder.icon);
const indent = computed(() => `${10 + (props.folder.depth ?? 0) * 16}px`);
const style = computed(() => ({
  paddingLeft: indent.value,
  '--folder-tone': props.folder.tone ?? undefined,
}));
const indexPercent = computed(() => Number(props.folder.index_percent ?? 0));
const showIndexProgress = computed(() =>
  Number(props.folder.total_emails ?? 0) > 100
  && indexPercent.value > 0
  && indexPercent.value < 100,
);
const dropStateValue = computed(() => props.dropState?.(props.folder) ?? null);
</script>

<template>
  <button
    type="button"
    class="folder-node"
    :class="{
      'is-current': current,
      'has-tone': folder.tone,
      'is-drop-valid': dropStateValue === 'valid',
      'is-drop-invalid': dropStateValue === 'invalid',
    }"
    :style="style"
    @click="onPick(folder.id)"
    @dragenter="onFolderDragEnter?.(folder, $event)"
    @dragover="onFolderDragOver?.(folder, $event)"
    @dragleave="onFolderDragLeave?.(folder, $event)"
    @drop="onFolderDrop?.(folder, $event)"
  >
    <component :is="Icon" :size="18" :stroke-width="1.75" class="folder-node__icon" />
    <span class="folder-node__name">{{ folder.name || '(unnamed)' }}</span>
    <span v-if="showIndexProgress" class="folder-node__index">{{ indexPercent }}%</span>
    <span v-if="unread > 0" class="folder-node__count">{{ unread > 99 ? '99+' : unread }}</span>
  </button>
  <FolderNode
    v-for="child in folder.children"
    :key="child.id"
    :folder="child"
    :current-folder-id="currentFolderId"
    :on-pick="onPick"
    :drop-state="dropState"
    :on-folder-drag-enter="onFolderDragEnter"
    :on-folder-drag-over="onFolderDragOver"
    :on-folder-drag-leave="onFolderDragLeave"
    :on-folder-drop="onFolderDrop"
  />
</template>

<script lang="ts">
export default { name: 'FolderNode' };
</script>

<style scoped>
.folder-node {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  background: transparent;
  border: 0;
  outline: 0;
  box-shadow: none;
  appearance: none;
  -webkit-appearance: none;
  border-radius: 8px;
  text-align: left;
  cursor: pointer;
  font: inherit;
  color: var(--text);
  width: 100%;
  min-width: 0;
}
.folder-node:hover { background: var(--rowHover); }
.folder-node:focus-visible { box-shadow: 0 0 0 2px var(--accent); }
.folder-node.is-current {
  background: var(--rowActive);
  color: var(--text);
  font-weight: 500;
}
.folder-node.is-drop-valid {
  background: color-mix(in srgb, var(--accent) 14%, var(--panel));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 55%, transparent);
}
.folder-node.is-drop-invalid {
  background: color-mix(in srgb, #d93025 12%, var(--panel));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, #d93025 55%, transparent);
  cursor: not-allowed;
}
.folder-node__icon {
  flex-shrink: 0;
  color: var(--muted);
}
.folder-node.has-tone .folder-node__icon,
.folder-node.has-tone.is-current .folder-node__icon {
  color: var(--folder-tone);
}
.folder-node.is-current:not(.has-tone) .folder-node__icon { color: var(--accent); }
.folder-node__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.folder-node__count {
  margin-left: auto;
  flex-shrink: 0;
  color: var(--muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  padding: 2px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text) 8%, transparent);
}
.folder-node__index {
  flex-shrink: 0;
  color: var(--muted);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  padding: 1px 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}
.folder-node.is-current .folder-node__count {
  color: var(--accent);
  font-weight: 600;
  background: color-mix(in srgb, var(--accent) 18%, transparent);
}
</style>
