<script setup lang="ts">
import { computed } from 'vue';
import { Plus, X } from '@lucide/vue';

import { useRepeaterRows } from '../../composables/useRepeaterRows';
import {
  createContactEditorResource,
  type ContactEditorEmail,
  type ContactEditorResource,
  type ContactResourceKind,
} from './contact-editor';
import AppIconButton from '../AppIconButton.vue';
import ContactLabelDropdown from './ContactLabelDropdown.vue';

const props = defineProps<{
  errors?: Record<string, string>;
  kind: ContactResourceKind;
  modelValue: ContactEditorResource[];
}>();

const emit = defineEmits<{
  'update:modelValue': [resources: ContactEditorResource[]];
}>();

const {
  appendRow: addResource,
  mapRows,
  removeRow: removeResource,
  replaceRow: replaceResource,
  updateRow: updateResource,
} = useRepeaterRows<ContactEditorResource>({
  rows: () => props.modelValue,
  createRow: (position) => {
    const resource = createContactEditorResource(props.kind);
    resource.position = position;
    if (props.kind === 'email' && position === 0) {
      (resource as ContactEditorEmail).isPreferred = true;
      resource.pref = 1;
    }
    return resource;
  },
  update: (resources) => emit('update:modelValue', resources),
});

const heading = computed(() => {
  switch (props.kind) {
    case 'email':
      return 'Email addresses';
    case 'phone':
      return 'Phone numbers';
    case 'website':
      return 'Websites';
    default: {
      const exhaustive: never = props.kind;
      return exhaustive;
    }
  }
});

const inputType = computed(() => {
  switch (props.kind) {
    case 'email':
      return 'email';
    case 'phone':
      return 'tel';
    case 'website':
      return 'url';
    default: {
      const exhaustive: never = props.kind;
      return exhaustive;
    }
  }
});

const placeholder = computed(() => {
  switch (props.kind) {
    case 'email':
      return 'name@example.com';
    case 'phone':
      return '+1 555 0100';
    case 'website':
      return 'https://example.com';
    default: {
      const exhaustive: never = props.kind;
      return exhaustive;
    }
  }
});

const addLabel = computed(() => {
  switch (props.kind) {
    case 'email':
      return 'Add email';
    case 'phone':
      return 'Add phone';
    case 'website':
      return 'Add website';
    default: {
      const exhaustive: never = props.kind;
      return exhaustive;
    }
  }
});

function makePrimary(formKey: string): void {
  if (props.kind !== 'email') return;
  mapRows((resource) => ({
    ...resource,
    isPreferred: resource.formKey === formKey,
    pref: resource.formKey === formKey ? 1 : null,
  }));
}

function errorId(formKey: string): string {
  return `contact-resource-error-${formKey}`;
}

function errorFor(formKey: string): string | null {
  return props.errors?.[formKey] ?? null;
}
</script>

<template>
  <fieldset class="contact-resource">
    <legend>{{ heading }}</legend>
    <div
      v-for="resource in modelValue"
      :key="resource.formKey"
      class="contact-resource__row"
      :data-field-key="resource.formKey"
    >
      <ContactLabelDropdown
        :kind="kind"
        :resource="resource"
        @update="replaceResource"
      />
      <input
        class="contact-editor__input contact-resource__value"
        :type="inputType"
        :value="resource.value"
        :placeholder="placeholder"
        :aria-label="`${heading} value`"
        :aria-describedby="errorFor(resource.formKey) ? errorId(resource.formKey) : undefined"
        :aria-invalid="errorFor(resource.formKey) ? 'true' : undefined"
        autocomplete="off"
        @input="updateResource(
          resource.formKey,
          { value: ($event.target as HTMLInputElement).value },
        )"
      />
      <button
        v-if="kind === 'email'"
        class="contact-resource__primary"
        type="button"
        :aria-pressed="(resource as ContactEditorEmail).isPreferred"
        :title="(resource as ContactEditorEmail).isPreferred
          ? 'Primary email'
          : 'Make primary email'"
        @click="makePrimary(resource.formKey)"
      >
        Primary
      </button>
      <AppIconButton
        class="contact-editor__remove"
        :aria-label="`Remove ${kind}`"
        @click="removeResource(resource.formKey)"
      >
        <X :size="15" :stroke-width="2" aria-hidden="true" />
      </AppIconButton>
      <p
        v-if="errorFor(resource.formKey)"
        :id="errorId(resource.formKey)"
        class="contact-resource__error"
        role="alert"
      >
        {{ errorFor(resource.formKey) }}
      </p>
    </div>
    <button class="contact-editor__add" type="button" @click="addResource">
      <Plus :size="14" :stroke-width="2" aria-hidden="true" />
      <span>{{ addLabel }}</span>
    </button>
  </fieldset>
</template>

<style scoped>
.contact-resource {
  display: grid;
  min-width: 0;
  gap: 8px;
  margin: 0;
  padding: 0;
  border: 0;
}

.contact-resource legend {
  margin-bottom: 7px;
  color: var(--muted, #6b7388);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}

.contact-resource__row {
  display: grid;
  min-width: 0;
  grid-template-columns: auto minmax(140px, 1fr) auto auto;
  align-items: start;
  gap: 6px;
}

.contact-resource__value {
  width: 100%;
}

.contact-resource__error {
  grid-column: 2 / -1;
  margin: 0;
  color: #c93838;
  font-size: 12px;
}

.contact-resource__primary {
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted, #6b7388);
  font: inherit;
  cursor: pointer;
  min-height: 34px;
  padding: 0 6px;
  font-size: 11px;
}

.contact-resource__primary[aria-pressed='true'] {
  color: var(--accent);
  font-weight: 700;
}

.contact-resource__primary:hover,
.contact-resource__primary:focus-visible {
  background: var(--rowHover, #f0f1f6);
  outline: none;
}

@media (max-width: 760px) {
  .contact-resource__row {
    grid-template-columns: minmax(0, 1fr) auto auto;
  }

  .contact-resource__row :deep(.contact-label) {
    grid-column: 1 / -1;
  }

  .contact-resource__error {
    grid-column: 1 / -1;
  }
}
</style>
