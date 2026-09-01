<script setup lang="ts">
import {
  computed,
  nextTick,
  ref,
  watch,
} from 'vue';

import { closeContainingDropdown } from '../../utils/dropdown';
import AppDropdown from '../AppDropdown.vue';
import {
  applyContactLabel,
  contactLabelChoice,
  contactLabelOptions,
  type ContactEditorResource,
  type ContactLabelChoice,
  type ContactResourceKind,
} from './contact-editor';

const props = defineProps<{
  kind: ContactResourceKind;
  resource: ContactEditorResource;
}>();

const emit = defineEmits<{
  update: [resource: ContactEditorResource];
}>();

const customInputEl = ref<HTMLInputElement | null>(null);
const customEditing = ref(
  contactLabelChoice(props.kind, props.resource) === 'custom',
);
const selectedChoice = computed(() =>
  customEditing.value
    ? 'custom'
    : contactLabelChoice(props.kind, props.resource));
const options = computed(() => contactLabelOptions(props.kind));
const summary = computed(() => {
  if (selectedChoice.value === 'custom') {
    return props.resource.label?.trim() || 'Custom';
  }
  return options.value.find((option) => option.value === selectedChoice.value)?.label
    ?? 'Other';
});

async function choose(choice: ContactLabelChoice, event: Event): Promise<void> {
  customEditing.value = choice === 'custom';
  if (choice !== 'custom') {
    emit('update', applyContactLabel(props.kind, props.resource, choice));
  }
  closeContainingDropdown(event);
  if (choice === 'custom') {
    await nextTick();
    customInputEl.value?.focus();
  }
}

function updateCustomLabel(event: Event): void {
  const value = (event.target as HTMLInputElement).value;
  emit(
    'update',
    value
      ? applyContactLabel(props.kind, props.resource, 'custom', value)
      : { ...props.resource, label: '' },
  );
}

watch(
  () => props.resource.formKey,
  () => {
    customEditing.value = contactLabelChoice(props.kind, props.resource) === 'custom';
  },
);
</script>

<template>
  <div class="contact-label">
    <AppDropdown group="contact-labels">
      <summary
        class="contact-label__summary app-dropdown__summary"
        :aria-label="`Choose ${kind} label; current label ${summary}`"
      >
        {{ summary }}
      </summary>
      <div class="app-dropdown__menu" role="menu">
        <button
          v-for="option in options"
          :key="option.value"
          class="app-dropdown__item"
          type="button"
          role="menuitemradio"
          :aria-checked="selectedChoice === option.value"
          @click="choose(option.value, $event)"
        >
          <span aria-hidden="true">{{ selectedChoice === option.value ? '✓' : '' }}</span>
          <span>{{ option.label }}</span>
        </button>
      </div>
    </AppDropdown>
    <input
      v-if="selectedChoice === 'custom'"
      ref="customInputEl"
      class="contact-label__custom"
      type="text"
      :value="resource.label ?? ''"
      :aria-label="`Custom ${kind} label`"
      placeholder="Custom label"
      autocomplete="off"
      @input="updateCustomLabel"
    />
  </div>
</template>

<style scoped>
.contact-label {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
}

.contact-label__summary,
.contact-label__custom {
  min-height: 34px;
  border: 1px solid var(--border, #d6d9e2);
  border-radius: 6px;
  background: var(--panel, #fff);
  color: var(--text, #1a1d24);
  font: inherit;
  font-size: 13px;
}

.contact-label__summary {
  display: inline-flex;
  min-width: 88px;
  align-items: center;
  justify-content: space-between;
  padding: 6px 9px;
}

.contact-label__custom {
  width: 120px;
  min-width: 0;
  padding: 6px 8px;
}

.contact-label__summary:focus-visible,
.contact-label__custom:focus-visible {
  border-color: var(--accent);
  outline: none;
}

@media (max-width: 639px) {
  .contact-label {
    align-items: stretch;
  }

  .contact-label__custom {
    flex: 1 1 auto;
  }
}
</style>
