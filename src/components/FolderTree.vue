<script setup lang="ts">
import { computed, ref } from 'vue';
import { Settings2 } from '@lucide/vue';

import { useMailStore } from '../stores/mail-store';
import { useMessageDragDrop } from '../composables/useMessageDragDrop';
import FolderNode from './FolderNode.vue';
import FolderManagerDialog from './FolderManagerDialog.vue';
import {
  folderCompare,
  folderPresentation,
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
  const visible = folderRows.filter((f) => Number(f.is_deleted) !== 1);
  const visibleById = new Map<number, any>(visible.map((f) => [f.id, f]));
  for (const folder of visible) {
    // Every starred folder is pulled out of its parent and rendered as
    // its own root in the favorites group — even when an ancestor is
    // starred too. One rule, no latent no-op stars: starring always
    // means "pin this folder as its own favorite".
    const parent = folder.parent_id != null ? visibleById.get(folder.parent_id) : null;
    const promotedByStar = Number(folder.is_starred) === 1 && parent != null;
    const key = parent != null && !promotedByStar ? folder.parent_id : 'ROOT';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(folder);
  }
  // Starred folders sort first within their sibling group; at the
  // root of the FOLDERS section that reads as a priority section.
  for (const list of byParent.values()) {
    list.sort(folderCompare);
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

const tree = computed(() => buildTree(mailStore.sidebarPrimaryFolders));

const mainFolders = computed(() => tree.value.filter(isMainFolder));
const userFolders = computed(() => tree.value.filter((f) => !isMainFolder(f)));

// Shared accounts (folders shared with the user by other principals),
// one section per owning account. Only subscribed folders show in the
// sidebar; the subscriptions dialog manages the full set.
const sharedTrees = computed(() => mailStore.sharedFolderGroups.map((group) => ({
  account: group.account,
  label: group.account.display_name ?? group.account.primary_email ?? 'Shared',
  tree: buildTree(group.folders),
})));

// Starred folders lead the FOLDERS section regardless of which account
// owns them: starred shared folders are pulled out of their account
// section into the same favorites group as the user's own. The
// leading gold star on each row is the only group marker; with no
// starred folders the layout is identical to the pre-star sidebar.
const starredUserFolders = computed(() => [
  ...userFolders.value.filter((f) => Number(f.is_starred) === 1),
  ...sharedTrees.value.flatMap(
    (section) => section.tree.filter((f) => Number(f.is_starred) === 1),
  ),
].sort(folderCompare));
const unstarredUserFolders = computed(
  () => userFolders.value.filter((f) => Number(f.is_starred) !== 1),
);

// What remains of each shared section once its starred folders moved
// to favorites; a fully-starred section drops its heading entirely.
const sharedSections = computed(() => sharedTrees.value
  .map((section) => ({
    ...section,
    tree: section.tree.filter((f) => Number(f.is_starred) !== 1),
  }))
  .filter((section) => section.tree.length > 0));

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
  return mailStore.transferModeForFolder(folder.id) ?? 'invalid';
}

function onFolderDragEnter(folder, event) {
  if (!hasMessageDrag(event)) return;
  dragOverFolderId.value = folder.id;
  setDropEffect(event, mailStore.transferModeForFolder(folder.id));
}

function onFolderDragOver(folder, event) {
  if (!hasMessageDrag(event)) return;
  dragOverFolderId.value = folder.id;
  setDropEffect(event, mailStore.transferModeForFolder(folder.id));
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
  const mode = mailStore.transferModeForFolder(folder.id);
  dragOverFolderId.value = null;
  try {
    if (payload?.ids?.length && mode) {
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
    <!--
      The heading row always renders (even with no user folders) so the
      manage button stays reachable without scrolling past the tree.
    -->
    <div class="folder-tree__heading-row">
      <h3 class="folder-tree__heading">Folders</h3>
      <span class="folder-tree__heading-actions">
        <button
          type="button"
          class="folder-tree__manage"
          title="Manage Folders"
          aria-label="Manage Folders"
          @click="showSubscriptionsDialog = true"
        >
          <Settings2 :size="16" :stroke-width="1.75" aria-hidden="true" />
        </button>
      </span>
    </div>
    <!-- Starred folders lead the section; the gold star at the left
         edge of each row marks the group, no labeled divider needed. -->
    <template v-if="starredUserFolders.length > 0">
      <FolderNode
        v-for="folder in starredUserFolders"
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
    <FolderNode
      v-for="folder in unstarredUserFolders"
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
  </nav>
  <FolderManagerDialog
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
.folder-tree__heading-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 14px 10px 4px;
}
.folder-tree__heading {
  margin: 14px 10px 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
}
.folder-tree__heading-row .folder-tree__heading {
  margin: 0;
}
.folder-tree__heading-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  /* Pull the buttons toward the sidebar edge so the icons align with
     the tree's right rail without inflating the heading row height. */
  margin: -4px -6px -4px 0;
}
.folder-tree__heading--shared {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.folder-tree__manage {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.folder-tree__manage:hover,
.folder-tree__manage:focus-visible {
  background: var(--rowHover);
  color: var(--text);
  outline: none;
}
</style>
