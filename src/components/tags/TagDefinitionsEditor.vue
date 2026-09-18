<script setup lang="ts">
/**
 * The tag manager's body (specs/011 §6): the ordered list of tags with
 * color and name, a form to add one, and the keywords found on cached
 * messages that no tag names yet. Keywords are immutable and shown as
 * hints; deleting a tag drops only its definition (MK-6.4). Definitions
 * live in the `messageTags` setting.
 */
import {
  computed, nextTick, onMounted, ref, watch,
} from 'vue';
import {
  ArrowDown, ArrowUp, Plus, Trash2,
} from '@lucide/vue';

import AppButton from '../AppButton.vue';
import { getRepositoryAsync } from '../../composables/useRepository';
import { useMessageTags } from '../../composables/useMessageTags';
import { useAuthStore } from '../../stores/auth-store';
import { useMailStore } from '../../stores/mail-store';
import { isComposingKeyEvent } from '../../utils/keyboard';
import {
  deriveTagKeyword,
  isSystemKeyword,
  MAX_TAG_DEFINITIONS,
  MAX_TAG_NAME_LENGTH,
  randomTagColor,
  normalizeKeyword,
  SYSTEM_KEYWORDS,
  tagNameError,
} from '../../utils/message-tags';

defineProps<{
  /** Id of the heading that names the list: the dialog's title. */
  labelledBy: string;
}>();

const authStore = useAuthStore();
const mailStore = useMailStore();
const {
  definitions,
  canCreate,
  createTag,
  defineKeyword,
  updateTag,
  moveTag,
  deleteTag,
} = useMessageTags();

const rootEl = ref<HTMLElement | null>(null);
/** Announced after a reorder or delete, which move or remove the focused control. */
const status = ref('');

/** Runs a settings write; a rejection is logged and reported, never thrown into the UI. */
async function run(action: () => Promise<unknown>, failure: string): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (error) {
    console.warn(`[tags] ${failure}`, error);
    status.value = `${failure}.`;
    return false;
  }
}

// ----- names: a draft per tag, committed on blur or Enter --------------
// Drafts keep a half-typed or invalid name across unrelated re-renders.
const nameDrafts = ref<Record<string, string>>({});
watch(definitions, (next) => {
  const drafts: Record<string, string> = {};
  for (const definition of next) {
    drafts[definition.keyword] = nameDrafts.value[definition.keyword] ?? definition.name;
  }
  nameDrafts.value = drafts;
}, { immediate: true });

async function commitName(keyword: string) {
  const definition = definitions.value.find((d) => d.keyword === keyword);
  if (!definition) return;
  const name = (nameDrafts.value[keyword] ?? '').trim();
  if (tagNameError(nameDrafts.value[keyword] ?? '')) return;
  if (name === definition.name) {
    nameDrafts.value[keyword] = definition.name;
    return;
  }
  const ok = await run(() => updateTag(keyword, { name }), 'Renaming the tag failed');
  if (!ok) nameDrafts.value[keyword] = definition.name;
}

async function commitColor(keyword: string, event: Event) {
  const color = (event.target as HTMLInputElement).value;
  await run(() => updateTag(keyword, { color }), 'Recoloring the tag failed');
}

// ----- add ----------------------------------------------------------------
const newName = ref('');
const composingName = ref(false);
const adoptedKeyword = ref<string | null>(null);
const newNameError = computed(() => newName.value.length > 0 ? tagNameError(newName.value) : null);
/** Drawn at random each time the manager opens and after each add; the user may pick another. */
const newColor = ref(randomTagColor(definitions.value));

const newKeyword = computed(() => (
  adoptedKeyword.value ?? deriveTagKeyword(newName.value, definitions.value.map((d) => d.keyword))
));
const canAdd = computed(() => canCreate.value && !tagNameError(newName.value) && newKeyword.value !== null);

async function add() {
  if (!canAdd.value || composingName.value) return;
  const name = newName.value;
  const color = newColor.value;
  const keyword = adoptedKeyword.value;
  const ok = await run(() => keyword ? defineKeyword(keyword, name, color) : createTag(name, color), 'Adding the tag failed');
  if (!ok) return;
  newName.value = '';
  adoptedKeyword.value = null;
  status.value = '';
  newColor.value = randomTagColor(definitions.value);
}

// ----- order and delete: keep keyboard focus on a live control ----------
function rowButton(keyword: string, label: string): HTMLElement | null {
  return rootEl.value?.querySelector<HTMLElement>(
    `[data-tag-setting="${keyword}"] [data-action="${label}"]`,
  ) ?? null;
}

async function move(keyword: string, direction: -1 | 1) {
  const definition = definitions.value.find((d) => d.keyword === keyword);
  if (!definition) return;
  const ok = await run(() => moveTag(keyword, direction), 'Reordering the tags failed');
  if (!ok) return;
  await nextTick();
  const index = definitions.value.findIndex((d) => d.keyword === keyword);
  const label = direction === -1 ? 'up' : 'down';
  const atEdge = direction === -1 ? index === 0 : index === definitions.value.length - 1;
  // The activated button disables at the edge; hand focus to its sibling.
  (rowButton(keyword, atEdge ? (direction === -1 ? 'down' : 'up') : label))?.focus();
  status.value = `${definition.name} moved ${label}, now ${index + 1} of ${definitions.value.length}.`;
}

async function remove(keyword: string) {
  const index = definitions.value.findIndex((d) => d.keyword === keyword);
  const definition = definitions.value[index];
  if (!definition) return;
  const next = definitions.value[index + 1] ?? definitions.value[index - 1] ?? null;
  const ok = await run(() => deleteTag(keyword), 'Deleting the tag failed');
  if (!ok) return;
  await nextTick();
  const target = next ? rowButton(next.keyword, 'delete') : rootEl.value?.querySelector<HTMLElement>('[data-tag-editor-name]');
  target?.focus();
  status.value = `Tag ${definition.name} deleted. Messages keep the keyword ${definition.keyword}.`;
}

// ----- keywords already on cached messages --------------------------------
// A tag set elsewhere (another client, a Sieve script) can be adopted
// as-is with a name and color. System keywords are excluded at the query.
const discovered = ref<Array<{ keyword: string; count: number }>>([]);
const discoverable = computed(() => {
  const defined = new Set(definitions.value.map((d) => normalizeKeyword(d.keyword)));
  return discovered.value.filter(({ keyword }) => (
    !isSystemKeyword(keyword) && !defined.has(normalizeKeyword(keyword))
  ));
});

async function loadDiscovered() {
  try {
    const repo = await getRepositoryAsync();
    if (typeof repo.listMessageKeywords !== 'function') return;
    const accountIds = mailStore.accounts.length > 0
      ? mailStore.accounts.map((account) => Number(account.id))
      : (authStore.accountId != null ? [authStore.accountId] : []);
    discovered.value = await repo.listMessageKeywords(accountIds, { excludeKeywords: [...SYSTEM_KEYWORDS] });
  } catch (error) {
    console.warn('[tags] listing message keywords failed', error);
    discovered.value = [];
  }
}

onMounted(() => { void loadDiscovered(); });
// Accounts arrive with the folder list; a dialog opened before that re-reads once they do.
watch(() => mailStore.accounts.length, (count, previous) => {
  if (count > 0 && previous === 0) void loadDiscovered();
});

async function adopt(keyword: string) {
  if (tagNameError(keyword)) {
    adoptedKeyword.value = keyword;
    newName.value = keyword;
    status.value = 'Choose a shorter display name. The keyword on your messages will stay unchanged.';
    await nextTick();
    rootEl.value?.querySelector<HTMLInputElement>('[data-tag-editor-name]')?.focus();
    return;
  }
  await run(() => defineKeyword(keyword), 'Adopting the keyword failed');
}
</script>

<template>
  <div ref="rootEl" class="tag-editor" data-tag-editor>
    <div class="tag-editor__intro">
      <p class="tag-editor__hint">
        Tags are stored alongside your messages, so they follow them into
        Thunderbird and other email clients. But the names and colors are defined
        separately by each client.
      </p>
      <span class="tag-editor__count">
        {{ definitions.length }} of {{ MAX_TAG_DEFINITIONS }}
      </span>
    </div>
    <p class="tag-editor__status" role="status" aria-live="polite">{{ status }}</p>

    <form class="tag-editor__add" data-tag-editor-add @submit.prevent="add">
      <input
        v-model="newColor"
        class="tag-editor__color"
        type="color"
        aria-label="Color of the new tag"
      >
      <input
        v-model="newName"
        class="tag-editor__name"
        type="text"
        :placeholder="canCreate ? 'New tag name' : `Up to ${MAX_TAG_DEFINITIONS} tags`"
        aria-label="Name of the new tag"
        aria-describedby="tag-editor-new-keyword tag-editor-name-help"
        :aria-invalid="newNameError ? true : undefined"
        :disabled="!canCreate"
        data-tag-editor-name
        @compositionstart="composingName = true"
        @compositionend="composingName = false"
        @keydown.enter="!isComposingKeyEvent($event) && !composingName && !canAdd && $event.preventDefault()"
      >
      <code id="tag-editor-new-keyword" class="tag-editor__keyword" :title="newKeyword ?? undefined">
        <span v-if="newKeyword" class="tag-editor__sr">Keyword </span>{{ newKeyword ?? '' }}
      </code>
      <AppButton
        form-action="submit"
        class="tag-editor__add-btn"
        :disabled="!canAdd"
        data-tag-editor-submit
      >
        <template #iconLeft>
          <Plus :size="15" :stroke-width="2" aria-hidden="true" />
        </template>
        {{ adoptedKeyword ? 'Use as tag' : 'New Tag' }}
      </AppButton>
    </form>
    <button v-if="adoptedKeyword" type="button" class="tag-editor__btn" data-tag-editor-cancel-adopt @click="adoptedKeyword = null; newName = ''; status = ''">
      Cancel adoption
    </button>
    <p id="tag-editor-name-help" class="tag-editor__hint" role="status">
      {{ newNameError ?? `Names can use any language, up to ${MAX_TAG_NAME_LENGTH} characters.` }}
    </p>

    <ol class="tag-editor__list" :aria-labelledby="labelledBy">
      <li
        v-for="(definition, index) in definitions"
        :key="definition.keyword"
        class="tag-editor__item"
        :data-tag-setting="definition.keyword"
      >
        <input
          class="tag-editor__color"
          type="color"
          :value="definition.color"
          :aria-label="`Color of ${definition.name}`"
          @change="commitColor(definition.keyword, $event)"
        >
        <input
          v-model="nameDrafts[definition.keyword]"
          class="tag-editor__name"
          type="text"
          :aria-label="`Name of ${definition.name}`"
          :aria-invalid="tagNameError(nameDrafts[definition.keyword] ?? '') ? true : undefined"
          :aria-describedby="`tag-keyword-${index} tag-name-error-${index}`"
          @blur="commitName(definition.keyword)"
          @keydown.enter="!isComposingKeyEvent($event) && ($event.target as HTMLInputElement).blur()"
        >
        <code :id="`tag-keyword-${index}`" class="tag-editor__keyword" :title="definition.keyword">
          <span class="tag-editor__sr">Keyword </span>{{ definition.keyword }}
        </code>
        <kbd v-if="index < 9" class="tag-editor__digit">
          <span class="tag-editor__sr">Press </span>{{ index + 1 }}<span class="tag-editor__sr"> to toggle</span>
        </kbd>
        <span v-else class="tag-editor__digit tag-editor__digit--none" aria-hidden="true" />
        <button
          type="button"
          class="tag-editor__icon-btn"
          data-action="up"
          :disabled="index === 0"
          :aria-label="`Move ${definition.name} up`"
          :title="`Move ${definition.name} up`"
          @click="move(definition.keyword, -1)"
        >
          <ArrowUp :size="15" :stroke-width="1.75" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="tag-editor__icon-btn"
          data-action="down"
          :disabled="index === definitions.length - 1"
          :aria-label="`Move ${definition.name} down`"
          :title="`Move ${definition.name} down`"
          @click="move(definition.keyword, 1)"
        >
          <ArrowDown :size="15" :stroke-width="1.75" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="tag-editor__icon-btn tag-editor__icon-btn--danger"
          data-action="delete"
          :aria-label="`Delete tag ${definition.name}`"
          :title="`Delete tag ${definition.name}. Messages keep the keyword.`"
          @click="remove(definition.keyword)"
        >
          <Trash2 :size="15" :stroke-width="1.75" aria-hidden="true" />
        </button>
        <span :id="`tag-name-error-${index}`" class="tag-editor__validation" role="status">{{ tagNameError(nameDrafts[definition.keyword] ?? '') }}</span>
      </li>
    </ol>


    <div v-if="discoverable.length > 0" class="tag-editor__discovered" data-tag-editor-discovered>
      <h3 class="tag-editor__subtitle">Keywords on your messages</h3>
      <p class="tag-editor__hint">
        Set by another client or a mail rule. Give one a name and color to use it as a tag.
      </p>
      <ul class="tag-editor__discovered-list">
        <li
          v-for="entry in discoverable"
          :key="entry.keyword"
          class="tag-editor__discovered-item"
        >
          <code class="tag-editor__keyword">{{ entry.keyword }}</code>
          <span class="tag-editor__discovered-count">
            {{ entry.count }} {{ entry.count === 1 ? 'message' : 'messages' }}
          </span>
          <button
            type="button"
            class="tag-editor__btn"
            :disabled="!canCreate"
            :aria-label="`Use ${entry.keyword} as a tag`"
            :data-tag-editor-adopt="entry.keyword"
            @click="adopt(entry.keyword)"
          >
            Use as tag
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.tag-editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 6px 18px 18px;
}
.tag-editor__intro {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.tag-editor__hint {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}
.tag-editor__count {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}
.tag-editor__status {
  min-height: 1em;
  margin: 0 0 4px;
  font-size: 12px;
  color: var(--muted);
}
.tag-editor__status:empty {
  margin: 0;
  min-height: 0;
}
.tag-editor__list {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 10px 0 0;
  border-top: 1px solid var(--border-soft);
  list-style: none;
}
.tag-editor__validation {
  grid-column: 2 / -1;
  font-size: 12px;
  color: var(--muted);
}
.tag-editor__validation:empty {
  display: none;
}
.tag-editor__item,
.tag-editor__add {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr) minmax(0, 120px) 22px auto auto auto;
  align-items: center;
  gap: 8px;
}
.tag-editor__add {
  grid-template-columns: 30px minmax(0, 1fr) minmax(0, 120px) auto;
}
.tag-editor__color {
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
}
.tag-editor__color::-webkit-color-swatch-wrapper {
  padding: 3px;
}
.tag-editor__color::-webkit-color-swatch,
.tag-editor__color::-moz-color-swatch {
  border: 0;
  border-radius: 4px;
}
.tag-editor__name {
  min-width: 0;
  height: 30px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
  font: inherit;
  font-size: 13px;
}
.tag-editor__name:focus-visible {
  border-color: var(--accent);
  outline: none;
}
.tag-editor__keyword {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--muted);
}
.tag-editor__digit {
  display: inline-grid;
  place-items: center;
  width: 22px;
  height: 20px;
  border: 1px solid var(--border-soft);
  border-radius: 4px;
  font: inherit;
  font-size: 10px;
  color: var(--muted);
}
.tag-editor__digit--none {
  border-color: transparent;
}
.tag-editor__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
.tag-editor__icon-btn {
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.tag-editor__icon-btn:hover:not(:disabled) {
  background: var(--rowHover);
  color: var(--text);
}
.tag-editor__icon-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
.tag-editor__icon-btn--danger:hover:not(:disabled) {
  background: rgba(255, 107, 107, 0.12);
  color: #ff6b6b;
}
.tag-editor__icon-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.tag-editor__btn {
  padding: 6px 14px;
  border: 1px solid var(--control-border);
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  white-space: nowrap;
}
.tag-editor__btn:hover:not(:disabled) {
  background: var(--rowHover);
}
.tag-editor__btn:disabled {
  opacity: 0.55;
  cursor: default;
}
.tag-editor__btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.tag-editor__add-btn {
  white-space: nowrap;
}
.tag-editor__discovered {
  display: grid;
  gap: 4px;
  margin-top: 10px;
  padding-top: 12px;
  border-top: 1px solid var(--border-soft);
}
.tag-editor__subtitle {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.tag-editor__discovered-list {
  display: grid;
  gap: 4px;
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
}
.tag-editor__discovered-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 10px;
}
.tag-editor__discovered-count {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}
@media (max-width: 560px) {
  .tag-editor__item {
    grid-template-columns: 30px minmax(0, 1fr) 22px repeat(3, 28px);
    column-gap: 6px;
  }
  .tag-editor__item > .tag-editor__color,
  .tag-editor__item > .tag-editor__name,
  .tag-editor__item > .tag-editor__digit,
  .tag-editor__item > .tag-editor__icon-btn {
    grid-row: 1;
  }
  .tag-editor__item > .tag-editor__keyword {
    grid-row: 2;
    grid-column: 2 / -1;
  }
  .tag-editor__add {
    grid-template-columns: 30px minmax(0, 1fr) auto;
  }
  .tag-editor__add > .tag-editor__keyword {
    grid-row: 2;
    grid-column: 2 / -1;
  }
  .tag-editor__add-btn {
    grid-row: 1;
    grid-column: 3;
  }
}
</style>
