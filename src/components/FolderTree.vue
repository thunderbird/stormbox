<script setup>
import { computed } from 'vue';
import {
  Inbox, Send, FileEdit, Archive, Trash2, ShieldAlert, Folder, FolderOpen,
} from 'lucide-vue-next';

import { useMailStore } from '../stores/mail-store.js';
import FolderNode from './FolderNode.vue';

const mailStore = useMailStore();

const ROLE_ICON = {
  inbox: Inbox,
  sent: Send,
  drafts: FileEdit,
  archive: Archive,
  trash: Trash2,
  junk: ShieldAlert,
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
    return {
      ...folder,
      depth,
      icon: ROLE_ICON[folder.role] ?? (children(folder.id).length ? FolderOpen : Folder),
      children: children(folder.id).map((c) => build(c, depth + 1)),
    };
  }
  return (byParent.get('ROOT') ?? []).map((f) => build(f, 0));
});

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

function isCurrent(id) { return mailStore.currentFolderId === id; }
function pickFolder(id) { mailStore.selectFolder(id); }
</script>

<template>
  <nav class="folder-tree" aria-label="Mailboxes">
    <FolderNode
      v-for="folder in tree"
      :key="folder.id"
      :folder="folder"
      :is-current="isCurrent"
      :on-pick="pickFolder"
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
