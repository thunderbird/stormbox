<script setup lang="ts">
import { computed, ref } from 'vue';

import { useMailStore } from '../stores/mail-store';
import { useMessageDragDrop } from '../composables/useMessageDragDrop';
import FolderNode from './FolderNode.vue';
import {
  folderPresentation,
  folderSortKey,
  isMainFolder,
} from '../utils/folder-presentation';

const mailStore = useMailStore();
const dragOverFolderId = ref(null);
const {
  isDragging,
  hasMessageDrag,
  readMessageDrop,
  setDropEffect,
  endMessageDrag,
} = useMessageDragDrop();

const tree = computed(() => {
  const byParent = new Map();
  for (const folder of mailStore.folders) {
    if (Number(folder.is_deleted) === 1) continue;
    const key = folder.parent_id ?? 'ROOT';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(folder);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => folderSortKey(a) - folderSortKey(b) || a.name.localeCompare(b.name));
  }
  function children(id) { return byParent.get(id) ?? []; }
  function build(folder, depth) {
    const childrenForFolder = children(folder.id);
    const presentation = folderPresentation(folder);
    return {
      ...folder,
      depth,
      icon: presentation.icon,
      tone: presentation.color,
      children: childrenForFolder.map((c) => build(c, depth + 1)),
    };
  }
  return (byParent.get('ROOT') ?? []).map((f) => build(f, 0));
});

const mainFolders = computed(() => tree.value.filter(isMainFolder));
const userFolders = computed(() => tree.value.filter((f) => !isMainFolder(f)));

// Track explicitly-expanded folders; everything else defaults to
// collapsed, so the tree starts fully closed.
const expandedFolderIds = ref(new Set());

function isFolderCollapsed(id) {
  return !expandedFolderIds.value.has(id);
}

function toggleFolderCollapsed(id) {
  const next = new Set(expandedFolderIds.value);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  expandedFolderIds.value = next;
}

function pickFolder(id) { mailStore.selectFolder(id); }

function dropStateFor(folder) {
  if (!isDragging.value || dragOverFolderId.value !== folder.id) return null;
  return mailStore.canMoveToFolder(folder.id) ? 'valid' : 'invalid';
}

function onFolderDragEnter(folder, event) {
  if (!hasMessageDrag(event)) return;
  dragOverFolderId.value = folder.id;
  setDropEffect(event, mailStore.canMoveToFolder(folder.id));
}

function onFolderDragOver(folder, event) {
  if (!hasMessageDrag(event)) return;
  dragOverFolderId.value = folder.id;
  setDropEffect(event, mailStore.canMoveToFolder(folder.id));
}

function onFolderDragLeave(folder, event) {
  if (event.currentTarget?.contains?.(event.relatedTarget)) return;
  if (dragOverFolderId.value === folder.id) {
    dragOverFolderId.value = null;
  }
}

async function onFolderDrop(folder, event) {
  if (!hasMessageDrag(event)) return;
  event.preventDefault();
  const payload = readMessageDrop(event);
  const canMove = mailStore.canMoveToFolder(folder.id);
  dragOverFolderId.value = null;
  try {
    if (payload?.ids?.length && canMove) {
      await mailStore.moveMessages(payload.ids, folder.id);
    }
  } catch (err) {
    console.warn('[folder-tree] moveMessages failed', err);
  } finally {
    endMessageDrag();
  }
}
</script>

<template>
  <nav class="folder-tree" aria-label="Mailboxes">
    <FolderNode
      v-for="folder in mainFolders"
      :key="folder.id"
      :folder="folder"
      :current-folder-id="mailStore.currentFolderId"
      :on-pick="pickFolder"
      :is-collapsed="isFolderCollapsed"
      :on-toggle="toggleFolderCollapsed"
      :drop-state="dropStateFor"
      :on-folder-drag-enter="onFolderDragEnter"
      :on-folder-drag-over="onFolderDragOver"
      :on-folder-drag-leave="onFolderDragLeave"
      :on-folder-drop="onFolderDrop"
    />
    <h3 v-if="userFolders.length > 0" class="folder-tree__heading">Folders</h3>
    <FolderNode
      v-for="folder in userFolders"
      :key="folder.id"
      :folder="folder"
      :current-folder-id="mailStore.currentFolderId"
      :on-pick="pickFolder"
      :is-collapsed="isFolderCollapsed"
      :on-toggle="toggleFolderCollapsed"
      :drop-state="dropStateFor"
      :on-folder-drag-enter="onFolderDragEnter"
      :on-folder-drag-over="onFolderDragOver"
      :on-folder-drag-leave="onFolderDragLeave"
      :on-folder-drop="onFolderDrop"
    />
  </nav>
</template>

<style scoped>
.folder-tree {
  display: flex;
  flex-direction: column;
  padding: 4px 6px;
  gap: 1px;
  min-height: 0;
}
.folder-tree__heading {
  margin: 14px 10px 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
}
</style>
