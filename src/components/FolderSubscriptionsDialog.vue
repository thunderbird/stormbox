<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { X } from '@lucide/vue';

import { useAuthStore } from '../stores/auth-store';
import { useMailStore } from '../stores/mail-store';
import type { AccountRow, FolderRow } from '../types';
import { folderSortKey } from '../utils/folder-presentation';

const emit = defineEmits<{ close: [] }>();

const authStore = useAuthStore();
const mailStore = useMailStore();
const closeButtonEl = ref<HTMLButtonElement | null>(null);

interface DialogFolderRow {
  folder: FolderRow;
  depth: number;
  subscribed: boolean;
  pending: boolean;
  editable: boolean;
}

interface DialogAccountSection {
  account: AccountRow;
  isOwn: boolean;
  label: string;
  rows: DialogFolderRow[];
}

/**
 * Depth-first flattening of one account's folder tree, mirroring the
 * sidebar's ordering (role folders first, then alphabetical).
 */
function flattenFolders(accountFolders: FolderRow[], isOwn: boolean): DialogFolderRow[] {
  const byParent = new Map<number | 'ROOT', FolderRow[]>();
  for (const folder of accountFolders) {
    if (Number(folder.is_deleted) === 1) continue;
    const key = folder.parent_id ?? 'ROOT';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(folder);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => folderSortKey(a) - folderSortKey(b) || a.name.localeCompare(b.name));
  }
  const out: DialogFolderRow[] = [];
  function walk(parentKey: number | 'ROOT', depth: number) {
    for (const folder of byParent.get(parentKey) ?? []) {
      out.push({
        folder,
        depth,
        subscribed: Number(folder.is_subscribed) === 1,
        pending: mailStore.subscriptionPendingFolderIds.has(folder.id),
        editable: canEditSubscription(folder, isOwn),
      });
      walk(folder.id, depth + 1);
    }
  }
  walk('ROOT', 0);
  return out;
}

/**
 * Whether the server would accept an isSubscribed update for this
 * folder. Own mailboxes are always editable. For shared mailboxes,
 * Stalwart requires the Modify ACL (surfaced as myRights.mayRename)
 * to change any Mailbox property, including isSubscribed.
 */
function canEditSubscription(folder: FolderRow, isOwn: boolean): boolean {
  if (isOwn) return true;
  if (!folder.rights_json) return true;
  try {
    const rights = JSON.parse(folder.rights_json);
    return rights?.mayRename !== false;
  } catch {
    return true;
  }
}

const sections = computed<DialogAccountSection[]>(() => mailStore.accounts.map((account) => {
  const isOwn = account.id === authStore.accountId;
  return {
    account,
    isOwn,
    label: isOwn
      ? `${account.display_name ?? account.primary_email ?? 'My account'} (my folders)`
      : account.display_name ?? account.primary_email ?? 'Shared account',
    rows: flattenFolders(
      mailStore.folders.filter((f) => f.account_id === account.id),
      isOwn,
    ),
  };
}).filter((section) => section.rows.length > 0));

async function toggle(row: DialogFolderRow) {
  if (row.pending || !row.editable) return;
  await mailStore.setFolderSubscription(row.folder.id, !row.subscribed);
}

// Escape must close the dialog even when focus has drifted to <body>
// (e.g. after a toggled checkbox is briefly disabled while its
// mutation is in flight), so listen at the window level instead of
// relying on bubbling from a focused descendant.
function onWindowKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('close');
}

onMounted(() => {
  closeButtonEl.value?.focus();
  window.addEventListener('keydown', onWindowKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown);
});
</script>

<template>
  <div class="folder-subs" role="presentation" @click.self="emit('close')">
    <section
      class="folder-subs__panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="folder-subs-title"
    >
      <header class="folder-subs__header">
        <h2 id="folder-subs-title">Folder subscriptions</h2>
        <button
          ref="closeButtonEl"
          type="button"
          class="folder-subs__close"
          aria-label="Close folder subscriptions"
          @click="emit('close')"
        >
          <X :size="18" :stroke-width="2" aria-hidden="true" />
        </button>
      </header>
      <p class="folder-subs__hint">
        Subscribed shared folders appear in your sidebar. Your own folders
        are always shown; their subscription state is kept for other mail
        clients that filter on it.
      </p>
      <div class="folder-subs__body">
        <section
          v-for="section in sections"
          :key="section.account.id"
          class="folder-subs__account"
        >
          <h3 class="folder-subs__account-name">
            {{ section.label }}
            <span v-if="!section.isOwn" class="folder-subs__badge">shared</span>
          </h3>
          <ul class="folder-subs__list">
            <li
              v-for="row in section.rows"
              :key="row.folder.id"
              class="folder-subs__row"
              :style="{ paddingLeft: `${8 + row.depth * 18}px` }"
            >
              <label class="folder-subs__label" :class="{ 'is-disabled': !row.editable }">
                <input
                  type="checkbox"
                  class="folder-subs__checkbox"
                  :checked="row.subscribed"
                  :disabled="row.pending || !row.editable"
                  :data-folder-name="row.folder.name"
                  @change="toggle(row)"
                />
                <span class="folder-subs__name">{{ row.folder.name || '(unnamed)' }}</span>
                <span v-if="row.pending" class="folder-subs__pending">saving…</span>
                <span
                  v-else-if="!row.editable"
                  class="folder-subs__pending"
                  title="You do not have permission to change the subscription for this folder."
                >read-only</span>
              </label>
            </li>
          </ul>
        </section>
        <p v-if="sections.length === 0" class="folder-subs__hint">No folders yet.</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.folder-subs {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: grid;
  place-items: center;
  padding: 16px;
  background: color-mix(in srgb, #000 55%, transparent);
}
.folder-subs__panel {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  width: min(440px, 100%);
  max-height: min(80vh, 640px);
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--panel);
  color: var(--text);
  box-shadow: 0 24px 60px color-mix(in srgb, #000 40%, transparent);
}
.folder-subs__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 18px 8px;
}
.folder-subs__header h2 {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
}
.folder-subs__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.folder-subs__close:hover,
.folder-subs__close:focus-visible {
  background: var(--rowHover);
  border-color: var(--border);
  color: var(--text);
  outline: none;
}
.folder-subs__hint {
  margin: 0;
  padding: 0 18px 10px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.4;
}
.folder-subs__body {
  min-height: 0;
  overflow-y: auto;
  padding: 0 12px 14px;
}
.folder-subs__account-name {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 6px 4px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted);
}
.folder-subs__badge {
  padding: 1px 7px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--accent);
  font-size: 10px;
  text-transform: none;
  letter-spacing: normal;
}
.folder-subs__list {
  margin: 0;
  padding: 0;
  list-style: none;
}
.folder-subs__row {
  border-radius: 8px;
}
.folder-subs__row:hover { background: var(--rowHover); }
.folder-subs__label {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  cursor: pointer;
  font-size: 13px;
}
.folder-subs__label.is-disabled {
  cursor: default;
  color: var(--muted);
}
.folder-subs__checkbox {
  flex-shrink: 0;
  width: 15px;
  height: 15px;
  accent-color: var(--accent);
}
.folder-subs__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.folder-subs__pending {
  flex-shrink: 0;
  color: var(--muted);
  font-size: 11px;
}
</style>
