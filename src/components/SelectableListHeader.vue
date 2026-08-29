<script setup lang="ts">
import { X } from '@lucide/vue';
import {
  ref,
  watchPostEffect,
} from 'vue';

const props = withDefaults(defineProps<{
  allSelected: boolean;
  clearClass?: string;
  countClass?: string;
  disabled?: boolean;
  itemLabel: string;
  selectable?: boolean;
  selectAllClass?: string;
  selectionActionsClass?: string;
  singularItemLabel?: string;
  selectedCount: number;
  totalCount: number;
}>(), {
  clearClass: '',
  countClass: '',
  disabled: false,
  selectAllClass: '',
  selectable: true,
  selectionActionsClass: '',
  singularItemLabel: '',
});

const emit = defineEmits<{
  clearSelection: [];
  toggleAll: [];
}>();

const selectAllEl = ref<HTMLInputElement | null>(null);

watchPostEffect(() => {
  if (!selectAllEl.value) return;
  selectAllEl.value.checked = props.allSelected;
  selectAllEl.value.indeterminate = props.selectedCount > 0 && !props.allSelected;
});
</script>

<template>
  <header class="selectable-list-header">
    <label
      v-if="selectable"
      :class="[
        'selectable-list-header__select-all',
        selectAllClass,
        { 'is-disabled': disabled || totalCount === 0 },
      ]"
      :title="
        disabled || totalCount === 0
          ? `No ${itemLabel} to select`
          : (allSelected ? `Deselect all ${itemLabel}` : `Select all ${itemLabel}`)
      "
    >
      <input
        ref="selectAllEl"
        type="checkbox"
        :checked="allSelected"
        :disabled="disabled || totalCount === 0"
        :indeterminate.prop="selectedCount > 0 && !allSelected"
        @change="emit('toggleAll')"
      />
    </label>

    <div
      v-if="selectedCount > 0"
      :class="[
        'selectable-list-header__selection-actions',
        selectionActionsClass,
      ]"
      role="group"
      aria-label="Selection actions"
    >
      <slot name="selection-actions" />
      <button
        :class="['selectable-list-header__clear', clearClass]"
        type="button"
        title="Clear selection"
        aria-label="Clear selection"
        @click="emit('clearSelection')"
      >
        <X :size="16" :stroke-width="1.75" aria-hidden="true" />
      </button>
    </div>
    <div v-else class="selectable-list-header__normal-actions">
      <slot name="normal-actions" />
    </div>

    <span
      :class="['selectable-list-header__count', countClass]"
      aria-live="polite"
    >
      <template v-if="selectedCount > 0">
        {{ selectedCount }} selected
      </template>
      <template v-else-if="totalCount > 0">
        {{ totalCount }} {{ totalCount === 1 ? (singularItemLabel || itemLabel) : itemLabel }}
      </template>
    </span>

    <slot name="trailing" />
  </header>
</template>

<style scoped>
.selectable-list-header {
  display: flex;
  min-height: var(--selectable-list-header-min-height, 57px);
  align-items: center;
  gap: 10px;
  padding: var(--selectable-list-header-padding, 11px 12px);
  border-bottom: 1px solid var(--border, #e3e6ee);
}

.selectable-list-header__select-all {
  display: grid;
  width: 34px;
  height: 34px;
  flex: 0 0 34px;
  place-items: center;
  cursor: pointer;
}

.selectable-list-header__select-all.is-disabled {
  cursor: default;
  opacity: 0.72;
}

.selectable-list-header__select-all input {
  width: 14px;
  height: 14px;
  margin: 0;
  accent-color: var(--accent);
  cursor: pointer;
}

.selectable-list-header__select-all input:disabled {
  cursor: default;
}

.selectable-list-header__selection-actions,
.selectable-list-header__normal-actions {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  align-items: center;
}

.selectable-list-header__selection-actions {
  gap: 4px;
  margin-inline-start: 8px;
}

.selectable-list-header__count {
  flex: 0 0 auto;
  color: var(--muted, #6b7388);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.selectable-list-header__clear {
  display: inline-grid;
  width: 34px;
  height: 34px;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--muted, #6b7388);
  cursor: pointer;
}

.selectable-list-header__clear:hover,
.selectable-list-header__clear:focus-visible {
  background: var(--rowHover, #f0f1f6);
  color: var(--text, #1a1d24);
  outline: none;
}
</style>
