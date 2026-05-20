<script setup>
import { computed, ref } from 'vue';
import {
  Inbox, Send, FileEdit, Archive, Trash2, ShieldAlert, Folder, FolderOpen,
  Newspaper, Rss,
} from 'lucide-vue-next';

import { useMailStore } from '../stores/mail-store.js';
import { useMessageDragDrop } from '../composables/use-message-drag-drop.js';
import FolderNode from './FolderNode.vue';

const mailStore = useMailStore();
const dragOverFolderId = ref(null);
const {
  isDragging,
  hasMessageDrag,
  readMessageDrop,
  setDropEffect,
  endMessageDrag,
} = useMessageDragDrop();

const ROLE_ICON = {
  inbox: Inbox,
  sent: Send,
  drafts: FileEdit,
  archive: Archive,
  trash: Trash2,
  junk: ShieldAlert,
};

const ROLE_COLOR = {
  inbox: '#1a73e8',
  sent: '#188038',
  drafts: '#7e22ce',
  archive: '#8b5a2b',
  trash: '#5f6368',
  junk: '#d93025',
  important: '#f9ab00',
  flagged: '#c5221f',
  all: '#5f6368',
};

const DEFAULT_FOLDER_BY_NAME = {
  newsletters: { icon: Newspaper, color: '#7378a6' },
  feeds: { icon: Rss, color: '#f97316' },
};

const tree = computed(() => {
  const byParent = new Map();
  for (const folder of mailStore.folders) {
    if (Number(folder.is_deleted) === 1) continue;
    const key = folder.parent_id ?? 'ROOT';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(folder);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => sortKey(a) - sortKey(b) || a.name.localeCompare(b.name));
  }
  function children(id) { return byParent.get(id) ?? []; }
  function build(folder, depth) {
    const childrenForFolder = children(folder.id);
    const presentation = folderPresentation(folder, childrenForFolder.length > 0);
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

function folderPresentation(folder, hasChildren) {
  const namedDefault = DEFAULT_FOLDER_BY_NAME[defaultFolderKey(folder.name)];
  return {
    icon: ROLE_ICON[folder.role] ?? namedDefault?.icon ?? (hasChildren ? FolderOpen : Folder),
    color: ROLE_COLOR[folder.role] ?? namedDefault?.color ?? null,
  };
}

function defaultFolderKey(name) {
  return String(name ?? '').trim().toLowerCase();
}

function sortKey(folder) {
  switch (folder.role) {
    case 'inbox': return 0;
    case 'drafts': return 1;
    case 'sent': return 2;
    case 'archive': return 3;
    case 'junk': return 4;
    case 'trash': return 5;
    default: return 100;
  }
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
      v-for="folder in tree"
      :key="folder.id"
      :folder="folder"
      :current-folder-id="mailStore.currentFolderId"
      :on-pick="pickFolder"
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
</style>
