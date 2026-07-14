<script setup lang="ts">
import { computed, ref } from 'vue';
import { Settings2 } from '@lucide/vue';

import { useMailStore } from '../stores/mail-store';
import { useMessageDragDrop } from '../composables/useMessageDragDrop';
import FolderNode from './FolderNode.vue';
import FolderSubscriptionsDialog from './FolderSubscriptionsDialog.vue';
import {
  folderPresentation,
  folderSortKey,
  isMainFolder,
} from '../utils/folder-presentation';

const mailStore = useMailStore();
const dragOverFolderId = ref(null);
const showSubscriptionsDialog = ref(false);
const {
  isDragging,
  hasMessageDrag,
  readMessageDrop,
  setDropEffect,
  endMessageDrag,
} = useMessageDragDrop();

function buildTree(folderRows) {
  const byParent = new Map();
  // A folder whose parent is not in the rendered set (e.g. a subscribed
  // shared folder under an unsubscribed parent) is promoted to a root
  // so it stays reachable.
  const visibleIds = new Set(
    folderRows.filter((f) => Number(f.is_deleted) !== 1).map((f) => f.id),
  );
  for (const folder of folderRows) {
    if (Number(folder.is_deleted) === 1) continue;
    const key = folder.parent_id != null && visibleIds.has(folder.parent_id)
      ? folder.parent_id
      : 'ROOT';
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
    const builtChildren = childrenForFolder.map((c) => build(c, depth + 1));
    // Roll the subtree's unread total up to each node so a collapsed
    // folder can show the unread count of everything hidden beneath it.
    const ownUnread = Number(folder.unread_emails) || 0;
    const subtreeUnread = builtChildren.reduce(
      (sum, child) => sum + (Number(child.subtree_unread) || 0),
      ownUnread,
    );
    return {
      ...folder,
      depth,
      icon: presentation.icon,
      tone: presentation.color,
      children: builtChildren,
      subtree_unread: subtreeUnread,
    };
  }
  return (byParent.get('ROOT') ?? []).map((f) => build(f, 0));
}

const tree = computed(() => buildTree(mailStore.primaryFolders));

const mainFolders = computed(() => tree.value.filter(isMainFolder));
const userFolders = computed(() => tree.value.filter((f) => !isMainFolder(f)));

// Shared accounts (folders shared with the user by other principals),
// one section per owning account. Only subscribed folders show in the
// sidebar; the subscriptions dialog manages the full set.
const sharedSections = computed(() => mailStore.sharedFolderGroups.map((group) => ({
  account: group.account,
  label: group.account.display_name ?? group.account.primary_email ?? 'Shared',
  tree: buildTree(group.folders),
})));

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

    <template v-for="section in sharedSections" :key="section.account.id">
      <h3 class="folder-tree__heading folder-tree__heading--shared" :title="section.label">
        {{ section.label }}
      </h3>
      <FolderNode
        v-for="folder in section.tree"
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
    </template>

    <button
      type="button"
      class="folder-tree__manage"
      @click="showSubscriptionsDialog = true"
    >
      <Settings2 :size="14" :stroke-width="1.75" aria-hidden="true" />
      <span>Manage folders</span>
    </button>
  </nav>
  <FolderSubscriptionsDialog
    v-if="showSubscriptionsDialog"
    @close="showSubscriptionsDialog = false"
  />
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
.folder-tree__heading--shared {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-transform: none;
  letter-spacing: 0.02em;
}
.folder-tree__manage {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 4px 6px;
  padding: 6px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  text-align: left;
}
.folder-tree__manage:hover,
.folder-tree__manage:focus-visible {
  background: var(--rowHover);
  color: var(--text);
  outline: none;
}
</style>
