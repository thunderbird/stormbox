<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps({
  folder: { type: Object, required: true },
  currentFolderId: { type: [Number, String, null], default: null },
  onPick: { type: Function, required: true },
  isCollapsed: { type: Function, required: true },
  onToggle: { type: Function, required: true },
  dropState: { type: Function, default: null },
  onFolderDragEnter: { type: Function, default: null },
  onFolderDragOver: { type: Function, default: null },
  onFolderDragLeave: { type: Function, default: null },
  onFolderDrop: { type: Function, default: null },
});

const current = computed(() => props.currentFolderId === props.folder.id);
const unread = computed(() => Number(props.folder.unread_emails) || 0);
const iconSvg = computed(() => props.folder.icon);
const hasChildren = computed(() => (props.folder.children?.length ?? 0) > 0);
const collapsed = computed(() => hasChildren.value && props.isCollapsed(props.folder.id));
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

function toggle() {
  props.onToggle(props.folder.id);
}
</script>

<template>
  <div
    class="folder-node"
    :class="{
      'is-current': current,
      'has-tone': folder.tone,
      'is-drop-valid': dropStateValue === 'valid',
      'is-drop-invalid': dropStateValue === 'invalid',
    }"
    :style="style"
    @dragenter="onFolderDragEnter?.(folder, $event)"
    @dragover="onFolderDragOver?.(folder, $event)"
    @dragleave="onFolderDragLeave?.(folder, $event)"
    @drop="onFolderDrop?.(folder, $event)"
  >
    <button
      v-if="hasChildren"
      type="button"
      class="folder-node__toggle"
      :class="{ 'is-collapsed': collapsed }"
      :aria-expanded="!collapsed"
      :aria-label="collapsed ? 'Expand folder' : 'Collapse folder'"
      @click="toggle"
    >
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
    <span v-else class="folder-node__toggle folder-node__toggle--spacer" aria-hidden="true" />
    <button
      type="button"
      class="folder-node__button"
      @click="onPick(folder.id)"
    >
      <span class="folder-node__icon" aria-hidden="true" v-html="iconSvg" />
      <span class="folder-node__name">{{ folder.name || '(unnamed)' }}</span>
      <span v-if="showIndexProgress" class="folder-node__index">{{ indexPercent }}%</span>
      <span v-if="unread > 0" class="folder-node__count">{{ unread > 99999 ? '99999+' : unread }}</span>
    </button>
  </div>
  <template v-if="hasChildren && !collapsed">
    <FolderNode
      v-for="child in folder.children"
      :key="child.id"
      :folder="child"
      :current-folder-id="currentFolderId"
      :on-pick="onPick"
      :is-collapsed="isCollapsed"
      :on-toggle="onToggle"
      :drop-state="dropState"
      :on-folder-drag-enter="onFolderDragEnter"
      :on-folder-drag-over="onFolderDragOver"
      :on-folder-drag-leave="onFolderDragLeave"
      :on-folder-drop="onFolderDrop"
    />
  </template>
</template>

<script lang="ts">
export default { name: 'FolderNode' };
</script>

<style scoped>
.folder-node {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 10px 0 0;
  border-radius: 8px;
}
.folder-node:hover { background: var(--rowHover); }
.folder-node.is-current {
  background: var(--rowActive);
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
.folder-node__toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  margin: 7px 0;
  padding: 0;
  background: transparent;
  border: 0;
  border-radius: 4px;
  color: var(--muted);
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
}
.folder-node__toggle:hover { background: color-mix(in srgb, var(--text) 10%, transparent); }
.folder-node__toggle:focus-visible { box-shadow: 0 0 0 2px var(--accent); outline: 0; }
.folder-node__toggle svg {
  transition: transform 0.12s ease;
  transform: rotate(90deg);
}
.folder-node__toggle.is-collapsed svg { transform: rotate(0deg); }
.folder-node__toggle--spacer {
  cursor: default;
  background: transparent;
}
.folder-node__button {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 0;
  background: transparent;
  border: 0;
  outline: 0;
  box-shadow: none;
  appearance: none;
  -webkit-appearance: none;
  text-align: left;
  cursor: pointer;
  font: inherit;
  color: var(--text);
  flex: 1;
  min-width: 0;
}
.folder-node__button:focus-visible { box-shadow: 0 0 0 2px var(--accent); border-radius: 6px; }
.folder-node.is-current .folder-node__button { font-weight: 500; }
.folder-node__icon {
  display: block;
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  color: var(--muted);
}
.folder-node__icon :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}
.folder-node__icon :deep([fill="context-fill"]) {
  fill: color-mix(in srgb, currentColor 20%, transparent);
}
.folder-node__icon :deep([fill="context-stroke"]) {
  fill: currentColor;
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
