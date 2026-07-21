<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { X } from '@lucide/vue';

import { useAuthStore } from '../stores/auth-store';
import { useMailStore } from '../stores/mail-store';
import type { FolderRow } from '../types';
import { folderCapabilities } from '../utils/folder-capabilities';
import { folderSortKey } from '../utils/folder-presentation';

const props = withDefaults(
  defineProps<{
    /** Preselected parent folder; null = top level. */
    initialParentId?: number | null;
  }>(),
  { initialParentId: null },
);
const emit = defineEmits<{ close: [] }>();

const authStore = useAuthStore();
const mailStore = useMailStore();
const nameEl = ref<HTMLInputElement | null>(null);
const name = ref('');
const parentFolderId = ref<number | null>(props.initialParentId);
const failure = ref<string | null>(null);

interface ParentOption {
  id: number | null;
  label: string;
  group: string;
}

/**
 * Eligible parents: "Top Level" plus every folder of the signed-in
 * account, and shared folders whose owner granted mayCreateChild
 * (RFC 9670; Stalwart rejects top-level creates on shared accounts,
 * so shared accounts get no root option).
 */
const parentOptions = computed<ParentOption[]>(() => {
  const options: ParentOption[] = [];
  for (const account of mailStore.accounts) {
    const isOwn = account.id === authStore.accountId;
    const group = isOwn
      ? account.display_name ?? account.primary_email ?? 'My account'
      : `${account.display_name ?? account.primary_email ?? 'Shared account'} (shared)`;
    const rows = flatten(
      mailStore.folders.filter((f) => f.account_id === account.id),
    ).filter((entry) =>
      folderCapabilities(entry.folder, authStore.accountId).mayCreateChild);
    if (isOwn) {
      options.push({ id: null, label: 'Top Level', group });
    }
    for (const entry of rows) {
      options.push({
        id: entry.folder.id,
        label: `${'\u00a0'.repeat(entry.depth * 3)}${entry.folder.name || '(unnamed)'}`,
        group,
      });
    }
  }
  return options;
});

const groups = computed(() => {
  const byGroup = new Map<string, ParentOption[]>();
  for (const option of parentOptions.value) {
    if (!byGroup.has(option.group)) byGroup.set(option.group, []);
    byGroup.get(option.group)!.push(option);
  }
  return [...byGroup.entries()].map(([label, options]) => ({ label, options }));
});

function flatten(accountFolders: FolderRow[]): Array<{ folder: FolderRow; depth: number }> {
  const byParent = new Map<number | 'ROOT', FolderRow[]>();
  for (const folder of accountFolders) {
    if (Number(folder.is_deleted) === 1) continue;
    const key = folder.parent_id ?? 'ROOT';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(folder);
  }
  for (const list of byParent.values()) {
    // Structural order (role, then name): the parent picker mirrors
    // the manager dialog's tree, not the sidebar's starred grouping.
    list.sort((a, b) => folderSortKey(a) - folderSortKey(b) || a.name.localeCompare(b.name));
  }
  const out: Array<{ folder: FolderRow; depth: number }> = [];
  function walk(parentKey: number | 'ROOT', depth: number) {
    for (const folder of byParent.get(parentKey) ?? []) {
      out.push({ folder, depth });
      walk(folder.id, depth + 1);
    }
  }
  walk('ROOT', 0);
  return out;
}

const canSubmit = computed(() => name.value.trim().length > 0 && !mailStore.folderCreatePending);

async function submit() {
  if (!canSubmit.value) return;
  failure.value = null;
  const result = await mailStore.createFolder({
    name: name.value,
    parentFolderId: parentFolderId.value,
  });
  if (result.ok) {
    emit('close');
    return;
  }
  switch (result.reason) {
    case 'duplicateName':
      failure.value = 'A folder with that name already exists here.';
      break;
    case 'forbidden':
      failure.value = 'You do not have permission to create a folder here.';
      break;
    case 'overQuota':
      failure.value = 'This account has reached its folder limit. Delete some folders to make room.';
      break;
    case 'tooDeep':
      failure.value = 'Folders cannot be nested this deeply. Choose a parent closer to the top level.';
      break;
    default:
      failure.value = `Could not create the folder${result.reason ? ` (${result.reason})` : ''}.`;
  }
}

function onWindowKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('close');
}

onMounted(() => {
  nameEl.value?.focus();
  window.addEventListener('keydown', onWindowKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown);
});
</script>

<template>
  <!-- Teleported for the same containing-block reason as the manager
       dialog: the sidebar's transform would trap this fixed overlay. -->
  <Teleport to="body">
  <div class="folder-create" role="presentation" @click.self="emit('close')">
    <section
      class="folder-create__panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="folder-create-title"
    >
      <header class="folder-create__header">
        <h2 id="folder-create-title">New folder</h2>
        <button
          type="button"
          class="folder-create__close"
          aria-label="Close new folder"
          @click="emit('close')"
        >
          <X :size="18" :stroke-width="2" aria-hidden="true" />
        </button>
      </header>
      <form class="folder-create__form" @submit.prevent="submit">
        <label class="folder-create__field">
          <span>Name</span>
          <input
            ref="nameEl"
            v-model="name"
            type="text"
            class="folder-create__input"
            placeholder="Folder name"
            data-folder-create-name
          />
        </label>
        <label class="folder-create__field">
          <span>Parent</span>
          <select
            v-model="parentFolderId"
            class="folder-create__input"
            data-folder-create-parent
          >
            <optgroup v-for="group in groups" :key="group.label" :label="group.label">
              <option
                v-for="option in group.options"
                :key="option.id ?? 'root'"
                :value="option.id"
              >{{ option.label }}</option>
            </optgroup>
          </select>
        </label>
        <p v-if="failure" class="folder-create__error">{{ failure }}</p>
        <div class="folder-create__actions">
          <button
            type="button"
            class="folder-create__btn"
            @click="emit('close')"
          >Cancel</button>
          <button
            type="submit"
            class="folder-create__btn folder-create__btn--primary"
            :disabled="!canSubmit"
            data-folder-create-submit
          >{{ mailStore.folderCreatePending ? 'Creating…' : 'Create' }}</button>
        </div>
      </form>
    </section>
  </div>
  </Teleport>
</template>

<style scoped>
.folder-create {
  position: fixed;
  inset: 0;
  z-index: 130;
  display: grid;
  place-items: center;
  padding: 16px;
  background: color-mix(in srgb, #000 55%, transparent);
}
.folder-create__panel {
  width: min(400px, 100%);
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--panel);
  color: var(--text);
  box-shadow: 0 24px 60px color-mix(in srgb, #000 40%, transparent);
}
@media (max-width: 639px) {
  .folder-create {
    align-items: end;
    padding: 0;
  }
  .folder-create__panel {
    width: 100%;
    border-radius: 16px 16px 0 0;
    border-bottom: 0;
  }
}
.folder-create__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 18px 8px;
}
.folder-create__header h2 {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
}
.folder-create__close {
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
.folder-create__close:hover,
.folder-create__close:focus-visible {
  background: var(--rowHover);
  border-color: var(--border);
  color: var(--text);
  outline: none;
}
.folder-create__form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 6px 18px 16px;
}
.folder-create__field {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: var(--muted);
}
.folder-create__field > span {
  flex-shrink: 0;
  width: 64px;
}
.folder-create__input {
  flex: 1;
  min-width: 0;
  box-sizing: border-box;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 13px;
}
.folder-create__input:focus-visible {
  outline: none;
  border-color: var(--accent);
}
.folder-create__error {
  margin: 0;
  font-size: 12px;
  color: #d93025;
}
.folder-create__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
.folder-create__btn {
  padding: 6px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  font: inherit;
  font-size: 13px;
}
.folder-create__btn:hover:not(:disabled) { background: var(--rowHover); }
.folder-create__btn:disabled { opacity: 0.55; cursor: default; }
.folder-create__btn--primary {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
}
.folder-create__btn--primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent) 88%, #000);
}
</style>
