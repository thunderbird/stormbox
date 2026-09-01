<script setup lang="ts">
import { Plus, X } from '@lucide/vue';

import { useRepeaterRows } from '../../composables/useRepeaterRows';
import AppIconButton from '../AppIconButton.vue';
import {
  createContactEditorNote,
  type ContactEditorNote,
} from './contact-editor';

const props = defineProps<{
  modelValue: ContactEditorNote[];
}>();

const emit = defineEmits<{
  'update:modelValue': [notes: ContactEditorNote[]];
}>();

const {
  appendRow: addNote,
  removeRow: removeNote,
  updateRow,
} = useRepeaterRows<ContactEditorNote>({
  rows: () => props.modelValue,
  createRow: (position) => ({
    ...createContactEditorNote(),
    position,
  }),
  update: (notes) => emit('update:modelValue', notes),
});

function updateNote(formKey: string, value: string): void {
  updateRow(formKey, { value });
}
</script>

<template>
  <fieldset class="contact-notes">
    <legend>Notes</legend>
    <div
      v-for="note in modelValue"
      :key="note.formKey"
      class="contact-notes__row"
      :data-field-key="note.formKey"
    >
      <textarea
        class="contact-editor__input contact-notes__input"
        :value="note.value"
        rows="3"
        aria-label="Contact note"
        @input="updateNote(
          note.formKey,
          ($event.target as HTMLTextAreaElement).value,
        )"
      />
      <AppIconButton
        class="contact-editor__remove"
        aria-label="Remove note"
        @click="removeNote(note.formKey)"
      >
        <X :size="15" :stroke-width="2" aria-hidden="true" />
      </AppIconButton>
    </div>
    <button class="contact-editor__add" type="button" @click="addNote">
      <Plus :size="14" :stroke-width="2" aria-hidden="true" />
      <span>Add note</span>
    </button>
  </fieldset>
</template>

<style scoped>
.contact-notes {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  border: 0;
}

.contact-notes legend {
  margin-bottom: 7px;
  color: var(--muted, #6b7388);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}

.contact-notes__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 6px;
}

.contact-notes__input {
  width: 100%;
  min-height: 72px;
  resize: vertical;
}

</style>
