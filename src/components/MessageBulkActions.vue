<script setup lang="ts">
import type { BulkActionItem } from '../composables/useBulkActionItems';

/**
 * The inline bulk-action buttons of a checkbox selection. The owner
 * decides which actions exist and which of them stay in the header row
 * (see `useBulkActionItems` / `splitBulkActions`); this component only
 * renders that row of buttons. Actions that did not fit are the owner's
 * to show in its overflow menu.
 */
defineProps<{
  items: readonly BulkActionItem[];
}>();
</script>

<template>
  <button
    v-for="item in items"
    :key="item.id"
    class="msg-list__bulk-action"
    :class="{
      'msg-list__bulk-action--danger': item.variant === 'danger',
      'msg-list__bulk-action--star': item.variant === 'star',
      'msg-list__bulk-action--starred': item.variant === 'star' && item.pressed,
      'msg-list__bulk-action--whitelist': item.variant === 'whitelist',
    }"
    type="button"
    :disabled="item.disabled"
    :title="item.title"
    :aria-label="item.ariaLabel"
    :aria-pressed="item.variant === 'star' ? item.pressed : undefined"
    :data-bulk-action="item.id"
    @click="item.run()"
  >
    <template v-if="item.variant === 'whitelist'">
      {{ item.label }}
    </template>
    <span
      v-else-if="item.rawIcon"
      class="msg-list__bulk-icon msg-list__bulk-icon--folder"
      aria-hidden="true"
      v-html="item.rawIcon"
    />
    <component
      :is="item.icon"
      v-else-if="item.icon"
      :size="item.variant === 'star' ? 17 : item.variant === 'danger' ? 18 : 16"
      :stroke-width="item.variant === 'danger' ? 1.65 : 1.75"
      :fill="item.variant === 'star' ? (item.pressed ? 'currentColor' : 'none') : undefined"
    />
  </button>
</template>

<style scoped>
.msg-list__bulk-action {
  display: inline-grid;
  place-items: center;
  border: 0;
  background: transparent;
  color: var(--muted);
  width: 34px;
  height: 34px;
  padding: 0;
  border-radius: 8px;
  cursor: pointer;
  font: inherit;
  flex-shrink: 0;
}
.msg-list__bulk-action:hover {
  background: var(--rowHover);
  color: var(--text);
}
.msg-list__bulk-action--danger:hover {
  background: rgba(255, 107, 107, 0.12);
  color: #ff6b6b;
}
.msg-list__bulk-action--starred,
.msg-list__bulk-action--starred:hover {
  color: #f5b700;
}
/* "Not junk" is the contextual, Junk-only primary action; a filled
   accent button set apart from the icon buttons, matching the same
   action in the open-message toolbar. */
.msg-list__bulk-action--whitelist {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: auto;
  padding: 0 12px;
  margin-inline-end: 6px;
  background: var(--accent);
  color: #fff;
  border: 1px solid color-mix(in srgb, var(--accent) 80%, #000);
  border-radius: 6px;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.25;
  white-space: nowrap;
  box-shadow: 0 1px 2px color-mix(in srgb, #000 16%, transparent);
  transition: filter 0.12s ease, box-shadow 0.12s ease;
}
.msg-list__bulk-action--whitelist:hover {
  background: var(--accent);
  color: #fff;
  filter: brightness(1.04);
  box-shadow: 0 2px 5px color-mix(in srgb, #000 18%, transparent);
}
.msg-list__bulk-action--whitelist:disabled,
.msg-list__bulk-action--whitelist:disabled:hover {
  opacity: 0.5;
  filter: none;
  background: var(--accent);
  color: #fff;
}
.msg-list__bulk-icon--folder {
  width: 20px;
  height: 20px;
  display: block;
}
.msg-list__bulk-icon--folder :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
}
.msg-list__bulk-icon--folder :deep([fill="context-fill"]) {
  fill: color-mix(in srgb, currentColor 20%, transparent);
}
.msg-list__bulk-icon--folder :deep([fill="context-stroke"]) {
  fill: currentColor;
}
</style>
