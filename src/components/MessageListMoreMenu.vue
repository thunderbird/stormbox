<script setup lang="ts">
import { ref } from 'vue';
import type { Component } from 'vue';
import { Ellipsis } from '@lucide/vue';

import { useMenuKeyboard } from '../composables/useMenuKeyboard';
import { closeContainingDropdown } from '../utils/dropdown';
import AppDropdown from './AppDropdown.vue';

export interface MoreMenuItem {
  id: string;
  label: string;
  /** Lucide component, or raw SVG markup in `rawIcon`. */
  icon?: Component | null;
  rawIcon?: string;
  disabled?: boolean;
  /** Present for a toggle (rendered as a menuitemcheckbox). */
  checked?: boolean;
  danger?: boolean;
  run: () => void;
}

export interface MoreMenuGroup {
  id: string;
  /** Optional heading above the group's items. */
  label?: string;
  items: MoreMenuItem[];
}

/**
 * The header's overflow menu: whatever controls the row has no room for
 * (bulk actions, Refresh, the column control) as menu items. A menu in
 * the WAI-ARIA sense: arrow keys move, Enter/Space activate, Escape and
 * outside clicks close, and focus returns to the trigger.
 */
defineProps<{
  groups: MoreMenuGroup[];
  /** Accessible name of the trigger. */
  label?: string;
}>();

const triggerEl = ref<HTMLElement | null>(null);
const menuEl = ref<HTMLElement | null>(null);

const { onToggle, onKeydown } = useMenuKeyboard({
  menuEl,
  itemSelector: '[role="menuitem"]:not([aria-disabled="true"]), [role="menuitemcheckbox"]:not([aria-disabled="true"])',
});

function activate(item: MoreMenuItem, event: Event) {
  if (item.disabled) return;
  closeContainingDropdown(event);
  triggerEl.value?.focus();
  item.run();
}

function focusTrigger() {
  triggerEl.value?.focus();
}

defineExpose({ focusTrigger });
</script>

<template>
  <AppDropdown class="msg-list__more" @toggle="onToggle">
    <summary
      ref="triggerEl"
      class="app-dropdown__summary msg-list__more-trigger"
      aria-haspopup="menu"
      :aria-label="label ?? 'More actions'"
      :title="label ?? 'More actions'"
      data-more-menu
    >
      <Ellipsis :size="18" :stroke-width="1.75" aria-hidden="true" />
    </summary>
    <div
      ref="menuEl"
      class="app-dropdown__menu msg-list__more-menu"
      role="menu"
      :aria-label="label ?? 'More actions'"
      @keydown="onKeydown"
    >
      <template v-for="(group, index) in groups" :key="group.id">
        <div v-if="index > 0" class="msg-list__more-separator" role="separator" />
        <div v-if="group.label" class="app-dropdown__heading msg-list__more-heading" :title="group.label">
          {{ group.label }}
        </div>
        <button
          v-for="item in group.items"
          :key="item.id"
          class="app-dropdown__item msg-list__more-item"
          :class="{ 'msg-list__more-item--danger': item.danger }"
          type="button"
          :role="item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'"
          :aria-checked="item.checked === undefined ? undefined : item.checked"
          :aria-disabled="item.disabled ? 'true' : undefined"
          :data-more-item="item.id"
          @click="activate(item, $event)"
        >
          <span class="msg-list__more-icon" aria-hidden="true">
            <span v-if="item.rawIcon" class="msg-list__more-icon-raw" v-html="item.rawIcon" />
            <component :is="item.icon" v-else-if="item.icon" :size="16" :stroke-width="1.75" />
          </span>
          <span class="msg-list__more-label">{{ item.label }}</span>
        </button>
      </template>
    </div>
  </AppDropdown>
</template>

<style scoped>
.msg-list__more {
  flex: 0 0 auto;
}
.msg-list__more-trigger {
  display: inline-grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  color: var(--muted);
}
.msg-list__more-trigger::after {
  content: none;
}
.msg-list__more-trigger:hover,
.msg-list__more-trigger:focus-visible {
  background: var(--rowHover);
  color: var(--text);
  outline: none;
}
/* Anchored to the row's end so it opens inside the column at any width. */
.msg-list__more-menu {
  left: auto;
  right: 0;
  min-width: 200px;
}
.msg-list__more-separator {
  height: 1px;
  margin: 4px 2px;
  background: var(--border-soft);
}
.msg-list__more-heading {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.msg-list__more-item {
  width: 100%;
}
.msg-list__more-item[aria-disabled="true"] {
  opacity: 0.5;
  cursor: default;
}
.msg-list__more-item--danger {
  color: #ff6b6b;
}
.msg-list__more-icon {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  color: var(--muted);
}
.msg-list__more-item--danger .msg-list__more-icon {
  color: inherit;
}
.msg-list__more-icon-raw {
  display: block;
  width: 20px;
  height: 20px;
}
.msg-list__more-icon-raw :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}
.msg-list__more-icon-raw :deep([fill="context-fill"]) {
  fill: color-mix(in srgb, currentColor 20%, transparent);
}
.msg-list__more-icon-raw :deep([fill="context-stroke"]) {
  fill: currentColor;
}
.msg-list__more-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
