<script setup lang="ts">
import { computed } from 'vue';
import { Plus, X } from '@lucide/vue';

import { useRepeaterRows } from '../../composables/useRepeaterRows';
import { createIdentityOperationId } from '../../utils/identity-fields';
import AppIconButton from '../AppIconButton.vue';

interface IdentityAddressFormRow {
  formKey: string;
  originalName: string | null;
  name: string;
  email: string;
}

type IdentityAddressKind = 'bcc' | 'replyTo';

const props = withDefaults(defineProps<{
  errors?: Record<string, string>;
  kind: IdentityAddressKind;
  rows: IdentityAddressFormRow[];
}>(), {
  errors: () => ({}),
});

const emit = defineEmits<{
  touched: [];
  update: [rows: IdentityAddressFormRow[]];
}>();

const {
  appendRow: addRow,
  removeRow,
  updateRow: patchRow,
} = useRepeaterRows<IdentityAddressFormRow>({
  rows: () => props.rows,
  createRow: () => ({
    formKey: `address:${createIdentityOperationId()}`,
    originalName: null,
    name: '',
    email: '',
  }),
  update: (rows) => {
    emit('update', rows);
    emit('touched');
  },
});

const label = computed(() => {
  switch (props.kind) {
    case 'replyTo':
      return 'Reply-To addresses';
    case 'bcc':
      return 'Automatic Bcc addresses';
    default: {
      const exhaustive: never = props.kind;
      return exhaustive;
    }
  }
});

const shortLabel = computed(() => props.kind === 'replyTo' ? 'Reply-To' : 'Bcc');

function updateRow(
  formKey: string,
  property: 'email' | 'name',
  value: string,
): void {
  patchRow(formKey, { [property]: value });
}
</script>

<template>
  <fieldset class="identity-addresses">
    <legend>{{ label }}</legend>
    <div
      v-for="(row, index) in rows"
      :key="row.formKey"
      class="identity-addresses__row"
      :data-form-key="row.formKey"
    >
      <label>
        <span>Display name (optional)</span>
        <input
          class="identity-addresses__input"
          type="text"
          :aria-label="`${shortLabel} display name ${index + 1}`"
          :value="row.name"
          @input="updateRow(
            row.formKey,
            'name',
            ($event.target as HTMLInputElement).value,
          )"
        />
      </label>
      <label>
        <span>Email address</span>
        <input
          class="identity-addresses__input"
          type="email"
          :aria-describedby="errors[row.formKey] ? `${row.formKey}-error` : undefined"
          :aria-invalid="errors[row.formKey] ? 'true' : undefined"
          :aria-label="`${shortLabel} email ${index + 1}`"
          :value="row.email"
          @input="updateRow(
            row.formKey,
            'email',
            ($event.target as HTMLInputElement).value,
          )"
        />
      </label>
      <AppIconButton
        class="contact-editor__remove identity-addresses__remove"
        :aria-label="`Remove ${shortLabel} address ${index + 1}`"
        @click="removeRow(row.formKey)"
      >
        <X :size="16" aria-hidden="true" />
      </AppIconButton>
      <p
        v-if="errors[row.formKey]"
        :id="`${row.formKey}-error`"
        class="identity-addresses__error"
        role="alert"
      >{{ errors[row.formKey] }}</p>
    </div>
    <button
      class="contact-editor__add identity-addresses__add"
      type="button"
      @click="addRow"
    >
      <Plus :size="15" aria-hidden="true" />
      Add {{ shortLabel }} address
    </button>
  </fieldset>
</template>

<style scoped>
.identity-addresses {
  display: grid;
  gap: 10px;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}

.identity-addresses legend {
  margin-bottom: 6px;
  color: var(--muted, #6b7388);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}

.identity-addresses__row {
  display: grid;
  grid-template-columns: minmax(100px, 0.7fr) minmax(160px, 1fr) auto;
  align-items: end;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--border-soft, #eef0f5);
  border-radius: 8px;
}

.identity-addresses__row label {
  display: grid;
  gap: 4px;
}

.identity-addresses__row label span {
  color: var(--muted, #6b7388);
  font-size: 11px;
}

.identity-addresses__input {
  min-width: 0;
  min-height: 34px;
  padding: 6px 9px;
  border: 1px solid var(--border, #d6d9e2);
  border-radius: 6px;
  background: var(--panel, #fff);
  color: var(--text, #1a1d24);
  font: inherit;
  font-size: 13px;
}

.identity-addresses__input:focus-visible {
  border-color: var(--accent);
  outline: none;
}

.identity-addresses__remove {
  border: 1px solid var(--border, #d6d9e2);
  color: #c93838;
}

.identity-addresses__add {
  width: max-content;
  min-height: 32px;
  padding: 5px 9px;
  border: 1px solid var(--border, #d6d9e2);
  color: inherit;
}

.identity-addresses__error {
  grid-column: 1 / -1;
  margin: 0;
  color: #c93838;
  font-size: 12px;
}

@media (max-width: 760px) {
  .identity-addresses__row {
    grid-template-columns: 1fr auto;
  }

  .identity-addresses__row label {
    grid-column: 1;
  }

  .identity-addresses__remove {
    grid-column: 2;
    grid-row: 1 / span 2;
    align-self: center;
  }
}
</style>
