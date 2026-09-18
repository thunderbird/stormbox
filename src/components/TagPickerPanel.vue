<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  Check, Minus, Settings2, X,
} from '@lucide/vue';

import { useMenuKeyboard } from '../composables/useMenuKeyboard';
import type { MessageRowLike } from '../utils/message-row-presentation';
import {
  normalizeKeyword,
  tagPresenceIndex,
  type MessageTagDefinition,
  type TagPresence,
} from '../utils/message-tags';

/**
 * The tag menu's contents (MK-6.6): "Remove All Tags" while any target
 * carries one, every defined tag as a tri-state checkbox over the target
 * rows, the target rows' keywords that have no definition, and "Manage
 * Tags…". While the menu has focus, 1–9 toggle the tag with that digit
 * and 0 removes every tag, as the list shortcuts do (MK-4.2), and T —
 * the key that opens it — closes it. Actions
 * apply at once and keep the menu open; the owner decides how the panel
 * is anchored and dismissed. New tags are defined in the tag manager.
 */
const props = withDefaults(defineProps<{
  targets: ReadonlyArray<MessageRowLike | null | undefined>;
  definitions: ReadonlyArray<MessageTagDefinition>;
  label?: string;
}>(), {
  label: 'Tags',
});

const emit = defineEmits<{
  /** Add (`on`) or remove the keyword on every target. */
  toggle: [keyword: string, on: boolean];
  /** Strip every tag from every target. */
  clear: [];
  /** Open tag management; the owner closes its menu first. */
  manage: [event: Event];
  /** T was pressed: the owner closes the menu as it would on Escape. */
  close: [];
}>();

const rootEl = ref<HTMLElement | null>(null);

const { onKeydown: onMenuKeydown } = useMenuKeyboard({
  menuEl: rootEl,
  itemSelector: '[role="menuitemcheckbox"], [role="menuitem"]',
});

interface PickerRow {
  keyword: string;
  name: string;
  color: string | null;
  presence: TagPresence;
  /** 1–9 in definition order (MK-4.2); null past the ninth or for undefined keywords. */
  digit: number | null;
}

/** Every target parsed once; presences for all rows come from this. */
const presenceIndex = computed(() => tagPresenceIndex(props.targets));

const definedRows = computed<PickerRow[]>(() => props.definitions.map((definition, index) => {
  const keyword = normalizeKeyword(definition.keyword);
  return {
    keyword,
    name: definition.name,
    color: definition.color,
    presence: presenceIndex.value.presence(keyword),
    digit: index < 9 ? index + 1 : null,
  };
}));

/** Keywords on the targets that no definition names, in first-seen order. */
const otherRows = computed<PickerRow[]>(() => {
  const defined = new Set(props.definitions.map((d) => normalizeKeyword(d.keyword)));
  return presenceIndex.value.keywords
    .filter((keyword) => !defined.has(keyword))
    .map((keyword) => ({
      keyword,
      name: keyword,
      color: null,
      presence: presenceIndex.value.presence(keyword),
      digit: null,
    }));
});

/** Offered while any target carries a tag. */
const showsClear = computed(() => presenceIndex.value.keywords.length > 0);

const isEmpty = computed(() => definedRows.value.length === 0 && otherRows.value.length === 0);

function toggle(row: PickerRow) {
  emit('toggle', row.keyword, row.presence !== 'all');
}

/**
 * Digits act on the menu's own rows: 1–9 toggle by definition order, 0
 * removes every tag. Shift is ignored for layouts that put digits on the
 * shifted row; any other modifier leaves the key alone.
 */
function onKeydown(event: KeyboardEvent) {
  const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
  if (plain && (event.key === 't' || event.key === 'T')) {
    event.preventDefault();
    event.stopPropagation();
    emit('close');
    return;
  }
  if (plain && /^[0-9]$/.test(event.key)) {
    event.preventDefault();
    event.stopPropagation();
    const digit = Number(event.key);
    if (digit === 0) {
      if (showsClear.value) emit('clear');
      return;
    }
    const row = definedRows.value[digit - 1];
    if (row) toggle(row);
    return;
  }
  onMenuKeydown(event);
}

function focusFirst() {
  rootEl.value?.querySelector<HTMLElement>('[role="menuitemcheckbox"], [role="menuitem"]')?.focus();
}

defineExpose({ focusFirst });
</script>

<template>
  <div
    ref="rootEl"
    class="tag-picker"
    role="menu"
    :aria-label="label"
    @keydown="onKeydown"
  >
    <template v-if="showsClear">
      <button
        class="app-dropdown__item tag-picker__item tag-picker__clear"
        type="button"
        role="menuitem"
        tabindex="-1"
        aria-keyshortcuts="0"
        data-tag-picker-clear
        @click="emit('clear')"
      >
        <span class="tag-picker__check" aria-hidden="true">
          <X :size="14" :stroke-width="2" />
        </span>
        <span class="tag-picker__name">Remove All Tags</span>
        <kbd class="tag-picker__digit" aria-hidden="true">0</kbd>
      </button>
      <div class="tag-picker__separator" role="separator" />
    </template>
    <div v-if="definedRows.length > 0" role="group" aria-label="Tags">
      <button
        v-for="row in definedRows"
        :key="row.keyword"
        class="app-dropdown__item tag-picker__item"
        type="button"
        role="menuitemcheckbox"
        tabindex="-1"
        :aria-checked="row.presence === 'all' ? 'true' : row.presence === 'some' ? 'mixed' : 'false'"
        :aria-keyshortcuts="row.digit !== null ? String(row.digit) : undefined"
        :data-tag-keyword="row.keyword"
        :style="row.color ? { '--tag-color': row.color } : undefined"
        @click="toggle(row)"
      >
        <span class="tag-picker__check" aria-hidden="true">
          <Check v-if="row.presence === 'all'" :size="14" :stroke-width="2.5" />
          <Minus v-else-if="row.presence === 'some'" :size="14" :stroke-width="2.5" />
        </span>
        <span class="tag-picker__dot" aria-hidden="true" />
        <span class="tag-picker__name">{{ row.name }}</span>
        <kbd v-if="row.digit !== null" class="tag-picker__digit" aria-hidden="true">{{ row.digit }}</kbd>
      </button>
    </div>
    <template v-if="otherRows.length > 0">
      <div v-if="definedRows.length > 0" class="tag-picker__separator" role="separator" />
      <div role="group" aria-label="Other keywords">
        <div class="app-dropdown__heading tag-picker__heading" aria-hidden="true">Other keywords</div>
        <button
          v-for="row in otherRows"
          :key="row.keyword"
          class="app-dropdown__item tag-picker__item tag-picker__item--undefined"
          type="button"
          role="menuitemcheckbox"
          tabindex="-1"
          :aria-checked="row.presence === 'all' ? 'true' : row.presence === 'some' ? 'mixed' : 'false'"
          :data-tag-keyword="row.keyword"
          :title="`${row.keyword} has no tag definition`"
          @click="toggle(row)"
        >
          <span class="tag-picker__check" aria-hidden="true">
            <Check v-if="row.presence === 'all'" :size="14" :stroke-width="2.5" />
            <Minus v-else-if="row.presence === 'some'" :size="14" :stroke-width="2.5" />
          </span>
          <span class="tag-picker__dot" aria-hidden="true" />
          <span class="tag-picker__name">{{ row.name }}</span>
        </button>
      </div>
    </template>
    <p v-if="isEmpty" class="tag-picker__empty" role="none">No tags defined yet.</p>
    <div class="tag-picker__separator" role="separator" />
    <button
      class="app-dropdown__item tag-picker__item tag-picker__manage"
      type="button"
      role="menuitem"
      tabindex="-1"
      data-tag-picker-manage
      @click="emit('manage', $event)"
    >
      <span class="tag-picker__check" aria-hidden="true">
        <Settings2 :size="14" :stroke-width="1.75" />
      </span>
      <span class="tag-picker__name">Manage Tags…</span>
    </button>
  </div>
</template>

<style scoped>
/* Sized to its content; it scrolls only when the owner caps its height
   (the popover, to the room left in the viewport). */
.tag-picker {
  display: grid;
  gap: 2px;
  min-width: 220px;
  max-height: inherit;
  overflow-y: auto;
}
.tag-picker__item {
  --tag-color: var(--muted);
  width: 100%;
  grid-template-columns: 20px 10px 1fr auto;
  column-gap: 8px;
}
.tag-picker__item:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.tag-picker__item[aria-checked='true'] {
  font-weight: 500;
}
.tag-picker__check {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  color: var(--accent);
}
.tag-picker__manage .tag-picker__check {
  color: var(--muted);
}
.tag-picker__manage {
  grid-template-columns: 20px 1fr;
}
.tag-picker__clear {
  grid-template-columns: 20px 1fr auto;
}
.tag-picker__clear .tag-picker__check {
  color: var(--muted);
}
.tag-picker__dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--tag-color);
}
.tag-picker__item--undefined .tag-picker__dot {
  background: transparent;
  border: 1.5px dashed var(--muted);
}
.tag-picker__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tag-picker__digit {
  display: inline-grid;
  place-items: center;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  box-sizing: border-box;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: color-mix(in srgb, var(--text) 6%, transparent);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  color: var(--text);
}
.tag-picker__separator {
  height: 1px;
  margin: 2px 2px;
  background: var(--border-soft);
}
.tag-picker__heading {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tag-picker__empty {
  margin: 0;
  padding: 8px;
  font-size: 12px;
  color: var(--muted);
}
</style>
