<script setup>
import { computed } from 'vue';
import { useMailStore } from '../stores/mail-store.js';

const mailStore = useMailStore();

/**
 * Group the flat folder list into roots (parent_id IS NULL) and a
 * children map. The recursive recursion is left to the template.
 */
const tree = computed(() => {
  const byParent = new Map();
  for (const folder of mailStore.folders) {
    const key = folder.parent_id ?? 'ROOT';
    if (!byParent.has(key)) {
      byParent.set(key, []);
    }
    byParent.get(key).push(folder);
  }
  return {
    roots: byParent.get('ROOT') ?? [],
    childrenOf(id) {
      return byParent.get(id) ?? [];
    },
  };
});

function isCurrent(id) {
  return mailStore.currentFolderId === id;
}

async function pickFolder(id) {
  await mailStore.selectFolder(id);
}
</script>

<template>
  <div class="folder-tree" role="tree" aria-label="Mailboxes">
    <FolderNode
      v-for="folder in tree.roots"
      :key="folder.id"
      :folder="folder"
      :get-children="tree.childrenOf"
      :is-current="isCurrent"
      :on-pick="pickFolder"
      :depth="0"
    />
  </div>
</template>

<script>
import { defineComponent, h } from 'vue';

const FolderNode = defineComponent({
  name: 'FolderNode',
  props: {
    folder: { type: Object, required: true },
    getChildren: { type: Function, required: true },
    isCurrent: { type: Function, required: true },
    onPick: { type: Function, required: true },
    depth: { type: Number, default: 0 },
  },
  setup(props) {
    return () => {
      const children = props.getChildren(props.folder.id);
      const current = props.isCurrent(props.folder.id);
      return [
        h(
          'button',
          {
            class: ['folder-tree__row', { 'is-current': current }],
            style: { paddingLeft: `${12 + props.depth * 14}px` },
            type: 'button',
            role: 'treeitem',
            'aria-selected': current ? 'true' : 'false',
            onClick: () => props.onPick(props.folder.id),
          },
          [
            h(
              'span',
              { class: 'folder-tree__name' },
              props.folder.name ?? '(unnamed)',
            ),
            props.folder.unread_emails > 0
              ? h('span', { class: 'folder-tree__count' }, String(props.folder.unread_emails))
              : null,
          ],
        ),
        ...children.map((child) =>
          h(FolderNode, {
            folder: child,
            getChildren: props.getChildren,
            isCurrent: props.isCurrent,
            onPick: props.onPick,
            depth: props.depth + 1,
            key: child.id,
          }),
        ),
      ];
    };
  },
});

export default { components: { FolderNode } };
</script>

<style scoped>
.folder-tree {
  display: flex;
  flex-direction: column;
  padding: 8px 0;
  overflow-y: auto;
}
.folder-tree__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 12px;
  background: transparent;
  border: 0;
  text-align: left;
  cursor: pointer;
  font: inherit;
  color: inherit;
  border-radius: 6px;
  margin: 0 8px;
}
.folder-tree__row:hover { background: rgba(0, 0, 0, 0.04); }
.folder-tree__row.is-current {
  background: var(--accent-bg, #e2e9fb);
  color: var(--accent-fg, #1d4ed8);
  font-weight: 500;
}
.folder-tree__name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.folder-tree__count {
  margin-left: 8px;
  background: rgba(0, 0, 0, 0.08);
  padding: 0 7px;
  border-radius: 8px;
  font-size: 11px;
  color: inherit;
}
</style>
