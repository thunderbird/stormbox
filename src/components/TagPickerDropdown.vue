<script setup lang="ts">
import { nextTick, ref } from 'vue';
import { Tag } from '@lucide/vue';

import { closeContainingDropdown } from '../utils/dropdown';
import type { MessageRowLike } from '../utils/message-row-presentation';
import type { MessageTagDefinition } from '../utils/message-tags';
import AppDropdown from './AppDropdown.vue';
import TagPickerPanel from './TagPickerPanel.vue';

/**
 * The tag menu as an AppDropdown: a 34px trigger in the bulk toolbar with
 * the picker panel beneath.
 * Opening focuses the first item; Escape and outside clicks close it
 * and toggles keep it open.
 */
withDefaults(defineProps<{
  targets: ReadonlyArray<MessageRowLike | null | undefined>;
  definitions: ReadonlyArray<MessageTagDefinition>;
  /** Accessible name of the trigger. */
  label?: string;
  /** Tooltip of the trigger; the label when omitted. */
  title?: string;
  /** Which edge of the trigger the panel lines up with. */
  align?: 'start' | 'end';
  disabled?: boolean;
  /** Extra classes on the trigger, for the owner's hooks. */
  triggerClass?: string;
}>(), {
  label: 'Tag',
  title: undefined,
  align: 'start',
  disabled: false,
  triggerClass: '',
});

const emit = defineEmits<{
  toggle: [keyword: string, on: boolean];
  clear: [];
  manage: [];
}>();

const triggerEl = ref<HTMLElement | null>(null);
const panelEl = ref<InstanceType<typeof TagPickerPanel> | null>(null);

function onToggle(event: Event) {
  const details = event.currentTarget as HTMLDetailsElement | null;
  if (!details?.open) return;
  void nextTick(() => panelEl.value?.focusFirst());
}

/** Manage tags… opens a dialog; the menu closes first so Escape there is the dialog's. */
function onManage(event: Event) {
  closeContainingDropdown(event);
  emit('manage');
}

/** T in the menu closes it like Escape: the menu shuts and focus returns to the trigger. */
function onPanelClose() {
  const details = triggerEl.value?.closest('details');
  if (details instanceof HTMLDetailsElement) details.open = false;
  triggerEl.value?.focus();
}

function focusTrigger() {
  triggerEl.value?.focus();
}

defineExpose({ focusTrigger });
</script>

<template>
  <AppDropdown class="tag-picker-dropdown" :disabled="disabled" @toggle="onToggle">
    <summary
      ref="triggerEl"
      class="app-dropdown__summary tag-picker-dropdown__trigger"
      :class="triggerClass"
      aria-haspopup="menu"
      :aria-label="label"
      :title="title ?? label"
      data-tag-picker-trigger
    >
      <slot name="trigger">
        <Tag :size="16" :stroke-width="1.75" aria-hidden="true" />
      </slot>
    </summary>
    <div
      class="app-dropdown__menu tag-picker-dropdown__menu"
      :class="{ 'tag-picker-dropdown__menu--end': align === 'end' }"
    >
      <TagPickerPanel
        ref="panelEl"
        :targets="targets"
        :definitions="definitions"
        @toggle="(keyword, on) => emit('toggle', keyword, on)"
        @clear="emit('clear')"
        @manage="onManage"
        @close="onPanelClose"
      />
    </div>
  </AppDropdown>
</template>

<style scoped>
.tag-picker-dropdown {
  flex: 0 0 auto;
}
.tag-picker-dropdown__trigger::after {
  content: none;
}
/* Same chrome as MessageBulkActions' buttons. */
.tag-picker-dropdown__trigger {
  display: inline-grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 8px;
  color: var(--muted);
}
.tag-picker-dropdown__trigger:hover,
.tag-picker-dropdown[open] > .tag-picker-dropdown__trigger {
  background: var(--rowHover);
  color: var(--text);
}
.tag-picker-dropdown__trigger:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
/* Content height, capped only by the viewport below the toolbar. */
.tag-picker-dropdown__menu {
  display: flex;
  flex-direction: column;
  min-width: 240px;
  max-height: calc(100vh - 140px);
  overflow: hidden;
}
.tag-picker-dropdown__menu > :deep(.tag-picker) {
  min-height: 0;
}
.tag-picker-dropdown__menu--end {
  left: auto;
  right: 0;
}
</style>
