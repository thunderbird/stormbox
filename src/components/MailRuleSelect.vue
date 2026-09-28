<script setup lang="ts">
import { computed, nextTick } from 'vue';
import { Check } from '@lucide/vue';

import AppDropdown from './AppDropdown.vue';
import { closeContainingDropdown } from '../utils/dropdown';

interface MailRuleSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

const props = withDefaults(defineProps<{
  modelValue: string;
  options: readonly MailRuleSelectOption[];
  controlLabel: string;
  placeholder?: string;
  disabled?: boolean;
}>(), {
  placeholder: 'Select an option',
  disabled: false,
});

const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void;
}>();

const selectedLabel = computed(() =>
  props.options.find((option) => option.value === props.modelValue)?.label ?? props.placeholder);

function containingDropdown(source: EventTarget | null): HTMLDetailsElement | null {
  if (!(source instanceof Element)) return null;
  const details = source.closest('details');
  return details instanceof HTMLDetailsElement ? details : null;
}

function enabledOptions(details: HTMLDetailsElement): HTMLButtonElement[] {
  return Array.from(details.querySelectorAll<HTMLButtonElement>('[data-rule-option]:not(:disabled)'));
}

async function openFromKeyboard(event: KeyboardEvent): Promise<void> {
  if (props.disabled) return;
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  event.preventDefault();
  const details = containingDropdown(event.currentTarget);
  if (!details) return;
  details.open = true;
  await nextTick();
  const options = enabledOptions(details);
  const target = event.key === 'ArrowDown' ? options[0] : options.at(-1);
  target?.focus();
}

function moveOptionFocus(event: KeyboardEvent): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const details = containingDropdown(event.currentTarget);
  if (!details) return;
  const options = enabledOptions(details);
  const current = event.currentTarget;
  if (!(current instanceof HTMLButtonElement) || options.length === 0) return;
  event.preventDefault();

  const currentIndex = options.indexOf(current);
  let targetIndex: number;
  if (event.key === 'Home') targetIndex = 0;
  else if (event.key === 'End') targetIndex = options.length - 1;
  else if (event.key === 'ArrowDown') targetIndex = (currentIndex + 1) % options.length;
  else targetIndex = (currentIndex - 1 + options.length) % options.length;
  options[targetIndex]?.focus();
}

function selectOption(option: MailRuleSelectOption, event: Event): void {
  if (props.disabled || option.disabled) return;
  const details = containingDropdown(event.currentTarget);
  emit('update:modelValue', option.value);
  closeContainingDropdown(event);
  details?.querySelector<HTMLElement>('summary')?.focus();
}
</script>

<template>
  <AppDropdown class="mail-rule-select" :disabled="disabled">
    <summary
      class="app-dropdown__summary app-dropdown__summary--control mail-rule-select__summary"
      :aria-label="controlLabel"
      :aria-disabled="disabled ? 'true' : undefined"
      aria-haspopup="menu"
      :tabindex="disabled ? -1 : undefined"
      @keydown="openFromKeyboard"
    >{{ selectedLabel }}</summary>
    <div class="app-dropdown__menu mail-rule-select__menu" role="menu" :aria-label="controlLabel">
      <button
        v-for="option in options"
        :key="option.value"
        class="app-dropdown__item"
        type="button"
        role="menuitemradio"
        :disabled="disabled || option.disabled"
        :aria-checked="option.value === modelValue"
        :data-rule-option="option.value"
        @click="selectOption(option, $event)"
        @keydown="moveOptionFocus"
      >
        <Check v-if="option.value === modelValue" :size="14" aria-hidden="true" />
        <span v-else aria-hidden="true" />
        <span>{{ option.label }}</span>
      </button>
    </div>
  </AppDropdown>
</template>

<style scoped>
.mail-rule-select {
  width: 100%;
  min-width: 0;
}
.mail-rule-select__summary {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  white-space: nowrap;
}
.mail-rule-select__menu {
  min-width: max(100%, 190px);
}
.mail-rule-select :deep(.app-dropdown__item:disabled) {
  cursor: default;
  opacity: 0.45;
}
</style>
